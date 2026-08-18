/* ==========================================================================
   PHYGITAL BRASIL — ENVIO DE ARQUIVO

   Uma rota só: POST /api/upload recebe a imagem ou o vídeo do banner, grava em
   site/assets/enviados/ e devolve o caminho público. DELETE /api/upload/:nome
   desfaz. É o que faltava para o editor de banners — antes a tela lia o arquivo
   escolhido e descartava, ou virava blob de URL.createObjectURL, que morre no
   recarregamento da página.

   Três decisões carregam a segurança deste arquivo:

   1. O TIPO É DECIDIDO PELOS PRIMEIROS BYTES, não pela extensão nem pelo
      Content-Type. Os dois vêm do cliente e mentem de graça; a assinatura está
      dentro do que foi gravado. Quem manda "foto.png" com um script dentro
      leva 400.

   2. O NOME DE DISCO É NOSSO. crypto.randomUUID() mais a extensão que a
      assinatura provou. O nome enviado nunca entra na montagem do caminho —
      é por ali que passa a travessia de diretório ('../../server/index.js') —
      e sobrevive apenas como metadado na resposta.

   3. O CORPO É Buffer DO COMEÇO AO FIM. Uma conversão para string no meio do
      caminho do multipart transforma qualquer byte fora do UTF-8 válido em
      U+FFFD, e todo PNG sai corrompido do outro lado.

   Sem dependência de npm: o multipart é analisado aqui, com indexOf de Buffer.
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('../db');
const regras = require('../regras');
const { ErroHttp, erro400, erro404, CORPO_MAX_ARQUIVO } = require('../http');

/* --------------------------------------------------------------------------
   DESTINO

   Resolvido uma vez, na carga do módulo, para servir de régua nas conferências
   de caminho mais abaixo.
   -------------------------------------------------------------------------- */

const PASTA = path.resolve(__dirname, '..', '..', 'site', 'assets', 'enviados');

/* O que a API devolve e o front-end grava no banner. Relativo de propósito: as
   páginas do site usam 'assets/…' e as dos painéis '../assets/…', e o
   validador de endereço de conteudo.js já aceita caminho do próprio site. */
const CAMINHO_PUBLICO = 'assets/enviados';

const PERMISSAO = 'banners:escrever';

/* --------------------------------------------------------------------------
   TETOS

   Separados por classe: 5 MB basta para a imagem de um hero e não deixa a
   folga de vídeo virar porta de entrada para encher o disco com PNG.
   -------------------------------------------------------------------------- */

const TETOS = {
  imagem: 5 * 1024 * 1024,
  video: 50 * 1024 * 1024
};

/* Um envio é um arquivo. O limite existe para um multipart com dez mil partes
   vazias não custar nada além do que já foi lido. */
const PARTES_MAX = 20;

/* --------------------------------------------------------------------------
   ASSINATURAS

   Lista branca. O que não casa com nenhuma linha daqui não é gravado.
   -------------------------------------------------------------------------- */

/** Compara bytes com um texto ASCII sem converter o arquivo inteiro. */
const marca = (b, inicio, texto) =>
  b.length >= inicio + texto.length
  && b.subarray(inicio, inicio + texto.length).toString('latin1') === texto;

const bytes = (b, inicio, ...esperados) =>
  b.length >= inicio + esperados.length
  && esperados.every((v, i) => b[inicio + i] === v);

const ASSINATURAS = [
  {
    ext: '.png',
    tipo: 'image/png',
    classe: 'imagem',
    casa: (b) => bytes(b, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  },
  {
    ext: '.jpg',
    tipo: 'image/jpeg',
    classe: 'imagem',
    casa: (b) => bytes(b, 0, 0xff, 0xd8, 0xff)
  },
  {
    /* RIFF é contêiner genérico (WAV também é RIFF): o 'WEBP' do byte 8 é que
       distingue. */
    ext: '.webp',
    tipo: 'image/webp',
    classe: 'imagem',
    casa: (b) => marca(b, 0, 'RIFF') && marca(b, 8, 'WEBP')
  },
  {
    ext: '.gif',
    tipo: 'image/gif',
    classe: 'imagem',
    casa: (b) => marca(b, 0, 'GIF8')
  },
  {
    /* Em MP4 os quatro primeiros bytes são o tamanho da caixa; a marca 'ftyp'
       começa no quinto. */
    ext: '.mp4',
    tipo: 'video/mp4',
    classe: 'video',
    casa: (b) => marca(b, 4, 'ftyp')
  },
  {
    /* Cabeçalho EBML — é o mesmo do Matroska, e é tudo que o navegador precisa
       para tocar o arquivo como webm. */
    ext: '.webm',
    tipo: 'video/webm',
    classe: 'video',
    casa: (b) => bytes(b, 0, 0x1a, 0x45, 0xdf, 0xa3)
  }
];

function reconhecer(dados) {
  const achada = ASSINATURAS.find((a) => a.casa(dados));
  if (!achada) {
    throw erro400(
      'Formato não aceito. Envie imagem (PNG, JPEG, WEBP ou GIF) ou vídeo (MP4 ou WEBM). '
      + 'O conteúdo do arquivo é conferido byte a byte, então renomear a extensão não resolve.'
    );
  }
  return achada;
}

/* --------------------------------------------------------------------------
   DIMENSÕES

   Opcionais: servem para a tela avisar que a imagem é pequena demais para um
   hero. Qualquer leitura que não bata devolve nada em vez de erro — dimensão
   ausente não é motivo para recusar um arquivo válido.
   -------------------------------------------------------------------------- */

function dimensoes(dados, ext) {
  try {
    if (ext === '.png' && marca(dados, 12, 'IHDR')) {
      return { largura: dados.readUInt32BE(16), altura: dados.readUInt32BE(20) };
    }
    if (ext === '.gif') {
      return { largura: dados.readUInt16LE(6), altura: dados.readUInt16LE(8) };
    }
    if (ext === '.jpg') return dimensoesJpeg(dados);
    if (ext === '.webp') return dimensoesWebp(dados);
  } catch (_) {
    /* Arquivo truncado no meio do cabeçalho: segue sem dimensão. */
  }
  return {};
}

/**
 * JPEG não tem as dimensões em posição fixa: é preciso caminhar de marcador em
 * marcador até um SOF (Start Of Frame), que é onde elas ficam.
 */
function dimensoesJpeg(dados) {
  let i = 2;
  while (i + 9 < dados.length) {
    if (dados[i] !== 0xff) { i += 1; continue; }

    const marcador = dados[i + 1];
    /* SOF0..SOF15, tirando DHT (c4), JPG (c8) e DAC (cc), que compartilham a
       faixa mas não descrevem quadro. */
    const ehSof = marcador >= 0xc0 && marcador <= 0xcf
      && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;

    if (ehSof) return { largura: dados.readUInt16BE(i + 7), altura: dados.readUInt16BE(i + 5) };

    /* 0xd8/0xd9 (início e fim) e 0xd0..0xd7 (reinício) não têm tamanho. */
    if (marcador === 0xd8 || marcador === 0xd9 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + dados.readUInt16BE(i + 2);
  }
  return {};
}

/** WEBP tem três formatos de bloco, cada um guardando o tamanho de um jeito. */
function dimensoesWebp(dados) {
  if (marca(dados, 12, 'VP8X')) {
    return {
      largura: (dados[24] | (dados[25] << 8) | (dados[26] << 16)) + 1,
      altura: (dados[27] | (dados[28] << 8) | (dados[29] << 16)) + 1
    };
  }
  if (marca(dados, 12, 'VP8L')) {
    const n = dados.readUInt32LE(21);
    return { largura: (n & 0x3fff) + 1, altura: ((n >> 14) & 0x3fff) + 1 };
  }
  if (marca(dados, 12, 'VP8 ')) {
    /* As dimensões vêm logo depois do código de sincronismo 9d 01 2a, e cada
       uma ocupa 14 bits — os 2 de cima são a escala. */
    return {
      largura: dados.readUInt16LE(26) & 0x3fff,
      altura: dados.readUInt16LE(28) & 0x3fff
    };
  }
  return {};
}

/* --------------------------------------------------------------------------
   LEITURA DO CORPO

   Versão própria de corpoBruto: quando estoura o teto ela para de acumular mas
   continua drenando, em vez de matar o soquete. Cortar a conexão faz o cliente
   ver "connection reset" no lugar do 413 e o operador não entende por que o
   envio falhou.

   O TETO SOBE, NÃO DESCE. A leitura começa valendo o menor teto (imagem) e só
   passa para o de vídeo quando a assinatura do conteúdo prova que é vídeo.

   Antes o corpo inteiro era lido até 52 MB e a classe só era conferida depois,
   então bastava declarar "imagem" e mandar 51 MB para prender 52 MB de memória
   por conexão — o teto de 5 MB era só o texto da mensagem de erro. Medido na
   revisão: 24 envios simultâneos levavam o processo de 681 MB para 925 MB.
   -------------------------------------------------------------------------- */

const erro413 = (limite) => new ErroHttp(
  413,
  `Arquivo grande demais: o limite é ${Math.round(limite / (1024 * 1024))} MB.`
);

/* Quanto do início do corpo é vasculhado atrás da assinatura. No envio binário
   cru ela está no byte 0; no multipart vem depois dos cabeçalhos da parte, que
   são algumas centenas de bytes. 8 KB cobre folgado os dois casos. */
const JANELA_ASSINATURA = 8 * 1024;

/** Procura uma assinatura conhecida em qualquer deslocamento da janela. */
function classeNaJanela(buffer) {
  const ate = Math.min(buffer.length, JANELA_ASSINATURA);
  for (let off = 0; off < ate; off++) {
    const fatia = buffer.subarray(off);
    const achada = ASSINATURAS.find((a) => a.casa(fatia));
    if (achada) return achada.classe;
  }
  return null;
}

function corpoDoArquivo(req, limiteMaximo) {
  return new Promise((resolver, rejeitar) => {
    const pedacos = [];
    let tamanho = 0;
    let excedeu = false;

    /* Presume o mais barato até o conteúdo dizer o contrário. */
    let limite = Math.min(TETOS.imagem, limiteMaximo);
    let classeConhecida = false;

    req.on('data', (p) => {
      tamanho += p.length;

      if (!excedeu) {
        pedacos.push(p);

        /* No máximo duas varreduras: uma assim que houver bytes para o
           cabeçalho do multipart caber, outra ao completar a janela. Vasculhar
           a cada pedaço custaria a janela inteira vezes o número de pedaços,
           sem achar nada que a segunda tentativa não ache. */
        if (!classeConhecida && (tamanho >= 1024 || req.readableEnded)) {
          const classe = classeNaJanela(Buffer.concat(pedacos));
          if (classe) {
            classeConhecida = true;
            limite = Math.min(TETOS[classe] || TETOS.imagem, limiteMaximo);
          } else if (tamanho >= JANELA_ASSINATURA) {
            /* Passou da janela sem casar com nada da lista branca: o teto de
               imagem fica valendo, porque continuar lendo dezenas de MB de um
               formato que será recusado no fim não ajuda ninguém. */
            classeConhecida = true;
          }
        }
      }

      if (excedeu || tamanho > limite) {
        if (!excedeu) {
          excedeu = true;
          pedacos.length = 0;      /* solta o que já tinha juntado */
        }

        /* Duas coisas diferentes, e confundi-las quebra uma delas:

           MEMÓRIA está protegida acima, ao parar de acumular — drenar não custa
           byte nenhum. Então o corte da conexão NÃO precisa acompanhar o teto da
           classe: se acompanhasse, um envio de 20 MB marcado como imagem teria o
           soquete morto em 10 MB e o operador veria "connection reset" no lugar
           da mensagem dizendo que o limite é 5 MB.

           O corte usa o teto absoluto do envelope, que é o ponto onde o cliente
           deixou de ser desastrado e passou a ser abusivo. */
        if (tamanho > limiteMaximo) {
          rejeitar(erro413(limite));
          req.destroy();
        }
      }
    });

    req.on('end', () => (excedeu ? rejeitar(erro413(limite)) : resolver(Buffer.concat(pedacos))));
    req.on('error', rejeitar);
  });
}

/* --------------------------------------------------------------------------
   MULTIPART/FORM-DATA

   O que um <input type="file"> manda. O formato é simples: as partes vêm
   separadas por CRLF + '--' + limite, e dentro de cada uma os cabeçalhos são
   separados do conteúdo por uma linha em branco (CRLFCRLF).
   -------------------------------------------------------------------------- */

function limiteDo(contentType) {
  const casou = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const valor = casou && (casou[1] || casou[2]);
  if (!valor) throw erro400('Envio multipart sem o separador (boundary) no Content-Type.');
  return valor;
}

function partesDo(bruto, limite) {
  const abertura = Buffer.from(`--${limite}`, 'latin1');
  /* Do segundo separador em diante o CRLF anterior faz parte do delimitador —
     e não do conteúdo da parte que acabou. */
  const separador = Buffer.from(`\r\n--${limite}`, 'latin1');

  let pos = bruto.indexOf(abertura);
  if (pos < 0) throw erro400('Envio multipart malformado: o separador não aparece no corpo.');
  pos += abertura.length;

  const partes = [];

  while (pos < bruto.length && partes.length < PARTES_MAX) {
    /* '--' logo após o separador é o fim do envelope. */
    if (bruto[pos] === 0x2d && bruto[pos + 1] === 0x2d) break;

    if (bruto[pos] === 0x0d && bruto[pos + 1] === 0x0a) pos += 2;
    else if (bruto[pos] === 0x0a) pos += 1;          /* cliente que manda só LF */
    else break;

    const fim = bruto.indexOf(separador, pos);
    if (fim < 0) throw erro400('Envio multipart malformado: uma parte não foi fechada.');

    partes.push(analisarParte(bruto.subarray(pos, fim)));
    pos = fim + separador.length;
  }

  return partes;
}

function analisarParte(parte) {
  const corte = parte.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  if (corte < 0) throw erro400('Envio multipart malformado: parte sem cabeçalhos.');

  /* Só os cabeçalhos viram texto. O conteúdo continua Buffer do começo ao fim:
     é ele que é binário. */
  const cabecalhos = parte.subarray(0, corte).toString('utf8');
  const conteudo = parte.subarray(corte + 4);

  const disposicao = /content-disposition\s*:\s*([^\r\n]*)/i.exec(cabecalhos);
  const tipo = /content-type\s*:\s*([^\r\n]*)/i.exec(cabecalhos);
  const linha = disposicao ? disposicao[1] : '';

  const nomeCampo = /;\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(linha);
  const nomeArquivo = /;\s*filename\s*\*?\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(linha);

  return {
    campo: nomeCampo ? (nomeCampo[1] || nomeCampo[2] || '').trim() : '',
    /* filename presente, ainda que vazio, é o que distingue arquivo de campo
       comum de formulário. */
    arquivo: Boolean(nomeArquivo),
    nomeOriginal: nomeArquivo ? (nomeArquivo[1] || nomeArquivo[2] || '').trim() : '',
    tipoDeclarado: tipo ? tipo[1].trim() : '',
    conteudo
  };
}

/* --------------------------------------------------------------------------
   NOME ORIGINAL

   Guardado como metadado e devolvido na resposta para a tela poder mostrar
   "banner-abertura.png". Nunca entra na montagem de caminho.
   -------------------------------------------------------------------------- */

function nomeApresentavel(cru) {
  const bruto = String(cru || '')
    .replace(/\\/g, '/')
    .split('/').pop()                        /* descarta qualquer trecho de caminho */
    .trim();

  /* Caractere de controle não é nome de arquivo, e ainda suja a auditoria. */
  let texto = '';
  for (const ch of bruto) {
    const codigo = ch.codePointAt(0);
    if (codigo >= 32 && codigo !== 127) texto += ch;
  }

  return texto.slice(0, 120);
}

/* --------------------------------------------------------------------------
   GRAVAÇÃO
   -------------------------------------------------------------------------- */

/**
 * Confere que o caminho montado continua dentro de site/assets/enviados/ —
 * a mesma conferência que server/index.js faz nos estáticos. Com o nome vindo
 * de randomUUID isto nunca deveria disparar; é justamente por isso que fica:
 * se um dia alguém trocar a origem do nome, o erro aparece aqui e não no disco.
 */
function destinoSeguro(nome) {
  const alvo = path.resolve(PASTA, nome);
  if (alvo !== path.join(PASTA, nome) || !alvo.startsWith(PASTA + path.sep)) {
    throw erro400('Nome de arquivo inválido.');
  }
  return alvo;
}

async function gravar(dados, assinatura) {
  const nome = `${crypto.randomUUID()}${assinatura.ext}`;
  const alvo = destinoSeguro(nome);

  await fs.promises.mkdir(PASTA, { recursive: true });
  /* 'wx' falha se o arquivo já existir: colisão de UUID é improvável a ponto de
     ser suspeita, e sobrescrever calado seria o pior desfecho possível. */
  await fs.promises.writeFile(alvo, dados, { flag: 'wx' });

  return nome;
}

/* --------------------------------------------------------------------------
   ROTAS
   -------------------------------------------------------------------------- */

async function enviar(ctx) {
  ctx.exigirAdmin(PERMISSAO);

  /* Content-Length exagerado é recusado antes de ler um byte. */
  const declarado = Number(ctx.req.headers['content-length'] || 0);
  if (declarado > CORPO_MAX_ARQUIVO) throw erro413();

  const contentType = String(ctx.req.headers['content-type'] || '');
  const bruto = await corpoDoArquivo(ctx.req, CORPO_MAX_ARQUIVO);
  if (!bruto.length) throw erro400('Nenhum arquivo foi enviado.');

  let dados;
  let nomeOriginal;

  if (/^multipart\/form-data/i.test(contentType)) {
    const partes = partesDo(bruto, limiteDo(contentType));
    const arquivo = partes.find((p) => p.arquivo && p.conteudo.length);
    if (!arquivo) throw erro400('Nenhum arquivo foi enviado no formulário.');
    dados = arquivo.conteudo;
    nomeOriginal = nomeApresentavel(arquivo.nomeOriginal);
  } else {
    /* Corpo binário cru: o fetch() do painel manda assim, sem envelope, e o
       nome de origem viaja no cabeçalho. */
    dados = bruto;
    nomeOriginal = nomeApresentavel(ctx.req.headers['x-nome-arquivo']);
  }

  const assinatura = reconhecer(dados);

  const teto = TETOS[assinatura.classe];
  if (dados.length > teto) {
    throw new ErroHttp(413,
      `${assinatura.classe === 'video' ? 'O vídeo' : 'A imagem'} passa do limite de `
      + `${Math.round(teto / (1024 * 1024))} MB.`);
  }

  const nome = await gravar(dados, assinatura);
  const medidas = assinatura.classe === 'imagem' ? dimensoes(dados, assinatura.ext) : {};

  regras.registrar(ctx, 'configuracao', nomeOriginal || nome, 'enviou arquivo',
    `${assinatura.tipo}, ${Math.round(dados.length / 1024)} kB`);

  return ctx.ok({
    ok: true,
    caminho: `${CAMINHO_PUBLICO}/${nome}`,
    nome,
    original: nomeOriginal || null,
    tipo: assinatura.tipo,
    classe: assinatura.classe,
    tamanho: dados.length,
    ...medidas
  });
}

/* Só o que esta rota gerou: UUID em minúsculas mais a extensão que a assinatura
   provou. Qualquer outra coisa é recusada ANTES de o caminho tocar o disco. */
const NOME_ENVIADO = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

async function apagar(ctx) {
  ctx.exigirAdmin(PERMISSAO);

  const nome = String(ctx.params.nome || '');
  if (!NOME_ENVIADO.test(nome)) throw erro400('Nome de arquivo inválido.');

  const alvo = destinoSeguro(nome);

  try {
    await fs.promises.unlink(alvo);
  } catch (e) {
    if (e.code === 'ENOENT') throw erro404('Arquivo não encontrado.');
    throw e;
  }

  regras.registrar(ctx, 'configuracao', nome, 'apagou arquivo enviado');

  return ctx.ok({ ok: true, nome });
}

/* --------------------------------------------------------------------------
   LIMPEZA DE ÓRFÃOS

   Trocar a imagem de um banner dez vezes deixava dez arquivos em enviados/: a
   rota DELETE existia, mas ninguém a chamava. Apagar pelo front-end no momento
   da troca não resolveria sozinho — ficariam de fora o upload abandonado antes
   de salvar, o banner excluído e a troca feita por outro caminho.

   Então a varredura é do servidor: arquivo que nenhuma linha do banco cita é
   órfão. A carência existe porque um arquivo recém-enviado ainda não está
   gravado em lugar nenhum — sem ela, a limpeza apagaria justamente o arquivo do
   formulário que o administrador tem aberto na tela.
   -------------------------------------------------------------------------- */

/* Toda coluna que pode guardar um caminho de enviados/. Faltar uma aqui apaga
   arquivo em uso, então a lista acompanha o esquema. */
const COLUNAS_COM_ARQUIVO = [
  ['banners_site', 'img'], ['banners_site', 'video'],
  ['banners', 'img'],
  ['posts', 'img'],
  ['parceiros', 'logo'],
  ['campeonatos', 'banner'],
  ['times', 'escudo'],
  ['jogadores', 'foto'],
  ['staff', 'foto']
];

const CARENCIA_MIN = 120;

function emUso() {
  const usados = new Set();

  for (const [tabela, coluna] of COLUNAS_COM_ARQUIVO) {
    /* Nomes de tabela e coluna são constantes deste arquivo, nunca entrada de
       usuário — não há caminho de injeção. */
    let linhas;
    try {
      linhas = db.todos(`SELECT "${coluna}" AS v FROM ${tabela} WHERE "${coluna}" IS NOT NULL`);
    } catch (_) {
      continue;   /* tabela ainda não existe num banco a meio caminho */
    }
    for (const l of linhas) {
      const v = String(l.v || '');
      if (v.includes('assets/enviados/')) usados.add(v.split('/').pop().split(/[?#]/)[0]);
    }
  }

  return usados;
}

/**
 * Apaga o que ninguém referencia. NUNCA lança: é faxina, não pode derrubar a
 * subida do servidor nem uma requisição.
 */
function limparOrfaos({ carenciaMin = CARENCIA_MIN } = {}) {
  const resumo = { apagados: 0, mantidos: 0, bytes: 0, erros: 0 };

  let arquivos;
  try { arquivos = fs.readdirSync(PASTA); } catch (_) { return resumo; }

  const usados = emUso();
  const corte = Date.now() - carenciaMin * 60000;

  for (const nome of arquivos) {
    if (nome === '.gitkeep') continue;

    const alvo = path.join(PASTA, nome);
    /* Mesma checagem do resto do módulo: nada fora da pasta é tocado. */
    if (!path.resolve(alvo).startsWith(PASTA + path.sep)) continue;

    try {
      const info = fs.statSync(alvo);
      if (!info.isFile()) continue;

      if (usados.has(nome) || info.mtimeMs > corte) { resumo.mantidos++; continue; }

      fs.unlinkSync(alvo);
      resumo.apagados++;
      resumo.bytes += info.size;
    } catch (_) {
      resumo.erros++;
    }
  }

  return resumo;
}

/** Faxina periódica. unref para o timer não segurar o processo no encerramento. */
function iniciarFaxina({ intervaloMs = 6 * 3600000 } = {}) {
  const relogio = setInterval(() => {
    try { limparOrfaos(); } catch (_) { /* nunca derruba o servidor */ }
  }, intervaloMs);
  relogio.unref();
  return relogio;
}

async function limpar(ctx) {
  ctx.exigirAdmin('banners:escrever');
  const corpo = await ctx.corpo().catch(() => ({}));

  /* Carência menor a pedido do operador, mas nunca zero: um upload em curso na
     tela de outro administrador continua protegido. */
  const carenciaMin = Math.max(5, Number(corpo.carenciaMin) || CARENCIA_MIN);

  const resumo = limparOrfaos({ carenciaMin });
  regras.registrar(ctx, 'configuracao', 'enviados',
    'limpou arquivos sem uso', `${resumo.apagados} apagado(s), ${Math.round(resumo.bytes / 1024)} KB`);

  return ctx.ok({ ok: true, ...resumo, carenciaMin });
}

function registrar(rotas) {
  rotas.post('/api/upload', enviar);
  rotas.delete('/api/upload/:nome', apagar);
  rotas.post('/api/upload/limpar', limpar);
}

module.exports = {
  registrar, PASTA, CAMINHO_PUBLICO, TETOS, ASSINATURAS,
  limparOrfaos, iniciarFaxina, COLUNAS_COM_ARQUIVO
};
