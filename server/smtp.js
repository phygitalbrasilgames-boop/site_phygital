/* ==========================================================================
   PHYGITAL BRASIL — CLIENTE SMTP E CONSTRUTOR DE MENSAGEM

   O Node não traz cliente SMTP e o projeto não pode ganhar dependência de npm,
   então ele está escrito aqui, sobre node:net, node:tls e node:crypto.

   Protocolo e formato da mensagem moram no MESMO arquivo de propósito: o que o
   montarMime() produz é exatamente o que o DATA transmite, e as duas pontas
   compartilham as mesmas regras de CRLF, de saneamento de cabeçalho e de
   codificação de corpo. Separá-los convidaria as duas metades a divergirem.

   O que este módulo NÃO faz:

   · não decide QUANDO enviar — quem faz isso é o despachante, que roda fora
     das transações de negócio (server/email.js grava com status 'fila' e volta
     na hora; uma falha de SMTP não pode desfazer a inscrição de um time);
   · não lê o banco nem o ambiente. A configuração chega por parâmetro, senha
     inclusive. A senha vem de PHYGITAL_SMTP_SENHA lá em cima e não é gravada,
     não é registrada em log e não aparece em mensagem de erro — o diálogo de
     diagnóstico anotado aqui troca a credencial por asteriscos ANTES de
     escrever no soquete, e não depois.

   Segurança de transporte:

   · porta 465 é TLS implícito — a conexão nasce cifrada (tls.connect);
   · porta 587 abre em texto e sobe com STARTTLS. Se o servidor não oferecer
     STARTTLS, o envio FALHA em vez de autenticar em claro;
   · o certificado é sempre validado. O escape config.permitirCertificadoInvalido
     existe só para servidor interno com certificado próprio e vem desligado.

   Referências: RFC 5321 (SMTP), 5322 (formato), 2045-2047 (MIME e cabeçalho
   codificado), 2231 (nome de arquivo com acento), 3207 (STARTTLS), 4616 (AUTH
   PLAIN).
   ========================================================================== */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

/* Terminador de linha do SMTP e do MIME. Em tudo, sem exceção. */
const CRLF = '\r\n';

/* Espera por resposta de cada etapa. Soquete pendurado não pode travar o
   processo: além deste, há um teto para a conversa inteira. */
const TIMEOUT_ETAPA = 30000;
const TIMEOUT_TOTAL_MIN = 120000;

const COLUNAS_BASE64 = 76;

/* RFC 5322: linha de cabeçalho até 78 colunas (o limite duro é 998). */
const LARGURA_CABECALHO = 78;

/* RFC 2047: um encoded-word inteiro cabe em 75 caracteres. Tirando o invólucro
   '=?UTF-8?B?' + '?=' (12) sobram 63 para o base64. Ficamos em 56 (múltiplo de
   4, ou seja, 42 bytes de texto) para a palavra fechar em 68 e ainda caber ao
   lado de 'Subject: ' dentro das 78 colunas — senão todo assunto acentuado
   começaria numa linha de continuação. */
const BYTES_POR_PALAVRA = 42;

/* Só as três primeiras linhas do diálogo interessam depois do erro; guardar
   tudo faria o registro crescer junto com o anexo. */
const DIALOGO_MAX = 40;

/* ==========================================================================
   1. SANEAMENTO

   Tudo que vem de fora (assunto vindo do admin, nome de time, nome de arquivo)
   atravessa daqui antes de virar cabeçalho. CR e LF em cabeçalho é injeção de
   cabeçalho SMTP: quem controla o assunto passaria a controlar o envelope.
   ========================================================================== */

/** Reduz um valor a uma linha só, sem CR, LF nem tabulação. */
function umaLinha(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Endereço pronto para ir entre <> no MAIL FROM/RCPT TO e no cabeçalho.
 * Fora do que um addr-spec aceita — espaço, <>, vírgula, ponto e vírgula, aspas
 * — nada sobrevive, porque qualquer um desses separa comandos ou destinatários.
 */
function enderecoLimpo(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/[\s<>",;:\\()[\]\u2028\u2029]/g, '')
    .slice(0, 320);                 /* 64 + '@' + 255, o teto do RFC 5321 */
}

/**
 * Aceita 'a@b.com', 'Nome <a@b.com>' ou { nome, endereco }.
 * @returns {{ nome: string, endereco: string }|null}
 */
function pessoa(valor) {
  if (!valor) return null;

  if (typeof valor === 'object') {
    const endereco = enderecoLimpo(valor.endereco || valor.email || '');
    return endereco ? { nome: umaLinha(valor.nome), endereco } : null;
  }

  const bruto = umaLinha(valor);
  const comNome = bruto.match(/^(.*?)<([^<>]*)>$/);

  if (comNome) {
    const nome = umaLinha(comNome[1]).replace(/^"(.*)"$/, '$1').trim();
    const endereco = enderecoLimpo(comNome[2]);
    return endereco ? { nome, endereco } : null;
  }

  const endereco = enderecoLimpo(bruto);
  return endereco ? { nome: '', endereco } : null;
}

/** Lista de destinatários a partir de string, string com vírgulas ou array. */
function listaDePessoas(valor) {
  const bruto = Array.isArray(valor) ? valor : String(valor || '').split(/[,;]+/);
  const vistos = new Set();
  const saida = [];

  for (const item of bruto) {
    const p = pessoa(item);
    if (!p) continue;
    const chave = p.endereco.toLowerCase();
    if (vistos.has(chave)) continue;   /* ninguém recebe a mesma cópia duas vezes */
    vistos.add(chave);
    saida.push(p);
  }
  return saida;
}

/* ==========================================================================
   2. CABEÇALHO: CODIFICAÇÃO (RFC 2047) E DOBRA (RFC 5322)
   ========================================================================== */

const SO_ASCII_IMPRIMIVEL = /^[\x20-\x7E]*$/;

/** Caracteres que obrigam um display-name a ir entre aspas (RFC 5322 specials). */
const ESPECIAIS = /[()<>@,;:\\".[\]]/;

/**
 * Quebra o texto em encoded-words de no máximo 75 caracteres.
 * O corte é contado em BYTES UTF-8 e feito entre pontos de código: partir um
 * caractere acentuado ao meio produz uma palavra que nenhum cliente decodifica.
 */
function palavrasCodificadas(texto) {
  const pedacos = [];
  let atual = '';
  let bytes = 0;

  for (const caractere of String(texto)) {
    const tamanho = Buffer.byteLength(caractere, 'utf8');
    if (bytes + tamanho > BYTES_POR_PALAVRA) {
      pedacos.push(atual);
      atual = '';
      bytes = 0;
    }
    atual += caractere;
    bytes += tamanho;
  }
  pedacos.push(atual);

  return pedacos.map((p) => `=?UTF-8?B?${Buffer.from(p, 'utf8').toString('base64')}?=`);
}

/**
 * Valor de cabeçalho pronto para uso. ASCII puro vai literal; qualquer acento
 * vira RFC 2047. Um texto ASCII que contenha '=?' também é codificado, senão o
 * cliente tentaria decodificá-lo como se fosse encoded-word.
 */
function codificarCabecalho(texto) {
  const limpo = umaLinha(texto);
  if (!limpo) return '';
  if (SO_ASCII_IMPRIMIVEL.test(limpo) && !limpo.includes('=?')) return limpo;
  return palavrasCodificadas(limpo).join(' ');
}

/** Nome de exibição de um endereço: literal, entre aspas ou codificado. */
function nomeExibicao(nome) {
  const limpo = umaLinha(nome);
  if (!limpo) return '';
  if (!SO_ASCII_IMPRIMIVEL.test(limpo) || limpo.includes('=?')) {
    return palavrasCodificadas(limpo).join(' ');
  }
  if (ESPECIAIS.test(limpo)) return `"${limpo.replace(/([\\"])/g, '\\$1')}"`;
  return limpo;
}

/** 'Nome <a@b.com>' ou apenas 'a@b.com'. */
function formatarPessoa(p) {
  const nome = nomeExibicao(p.nome);
  return nome ? `${nome} <${p.endereco}>` : p.endereco;
}

/**
 * Monta o cabeçalho quebrando entre tokens, com um espaço de recuo em cada
 * continuação — é a dobra ("folding") do RFC 5322. A quebra nunca acontece
 * dentro de um token, e é por isso que os encoded-words já vêm curtos e cada
 * endereço da lista é um token só.
 */
function dobrarTokens(nome, tokens) {
  const linhas = [];
  let atual = `${nome}:`;
  let temToken = false;

  for (const token of tokens) {
    const estourou = atual.length + 1 + token.length > LARGURA_CABECALHO;

    /* Quebrar só resolve se o token couber na linha de continuação — que
       começa com o espaço de recuo. Um token maior que a linha inteira (um
       endereço absurdamente longo) fica longo mesmo: parti-lo ao meio produz
       cabeçalho inválido, que é pior do que uma linha comprida.
       A própria linha do rótulo pode ser quebrada: 'Subject:' sozinho, com o
       valor na continuação, é dobra válida do RFC 5322. */
    if (estourou && 1 + token.length <= LARGURA_CABECALHO && (temToken || !linhas.length)) {
      linhas.push(atual);
      atual = '';
      temToken = false;
    }

    atual += ` ${token}`;
    temToken = true;
  }

  linhas.push(temToken ? atual : `${atual} `);
  return linhas.join(CRLF);
}

const dobrarTexto = (nome, valor) =>
  dobrarTokens(nome, String(valor || '').split(' ').filter(Boolean));

/** Lista de endereços: a vírgula gruda no token anterior para não abrir linha. */
const dobrarLista = (nome, itens) =>
  dobrarTokens(nome, itens.map((it, i) => (i < itens.length - 1 ? `${it},` : it)));

/** 'Content-Type: tipo; par1; par2' com a quebra caindo nos ';'. */
function dobrarParametros(nome, valor, parametros) {
  const tokens = [parametros.length ? `${valor};` : valor];
  parametros.forEach((p, i) => tokens.push(i < parametros.length - 1 ? `${p};` : p));
  return dobrarTokens(nome, tokens);
}

const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Data no formato do RFC 5322, sempre em UTC ('+0000' em vez do obsoleto 'GMT'). */
function dataRfc5322(quando) {
  const d = quando instanceof Date && !Number.isNaN(quando.getTime()) ? quando : new Date();
  const dois = (n) => String(n).padStart(2, '0');

  return `${DIAS[d.getUTCDay()]}, ${dois(d.getUTCDate())} ${MESES[d.getUTCMonth()]} `
    + `${d.getUTCFullYear()} ${dois(d.getUTCHours())}:${dois(d.getUTCMinutes())}:`
    + `${dois(d.getUTCSeconds())} +0000`;
}

/** Message-ID único, com o domínio do remetente — é o que o servidor espera ver. */
function novoIdMensagem(enderecoRemetente) {
  const dominio = enderecoLimpo(String(enderecoRemetente || '').split('@')[1] || '')
    || 'phygitalgamesbr.com.br';
  return `<${crypto.randomUUID()}@${dominio}>`;
}

/* ==========================================================================
   3. CORPO: CODIFICAÇÃO DE CONTEÚDO

   Nada sai como 8bit cru. Servidor sem 8BITMIME rebaixa a mensagem para 7bit e
   corrompe todo acento no caminho — o e-mail chega com "inscriÃ§Ã£o".
   ========================================================================== */

/** Base64 quebrado em 76 colunas, como o RFC 2045 exige. */
function base64Quebrado(conteudo) {
  const buffer = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
  const texto = buffer.toString('base64');
  const linhas = [];

  for (let i = 0; i < texto.length; i += COLUNAS_BASE64) {
    linhas.push(texto.slice(i, i + COLUNAS_BASE64));
  }
  return linhas.join(CRLF);
}

const hexDeByte = (b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Quoted-printable (RFC 2045). Usado na parte de texto puro porque mantém o
 * conteúdo legível a olho nu, o que ajuda a depurar o que foi enviado.
 *
 * Repare que um ponto sozinho no começo da linha continua um ponto sozinho:
 * quem protege isso é o dot-stuffing na hora do DATA, não a codificação.
 */
function quotedPrintable(texto) {
  const linhas = String(texto === null || texto === undefined ? '' : texto)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const saida = [];

  for (const linha of linhas) {
    const bytes = Buffer.from(linha, 'utf8');
    let atual = '';

    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i];
      const ultimo = i === bytes.length - 1;
      let token;

      if (b === 9 || b === 32) {
        /* Espaço no fim da linha some no transporte: só sobrevive codificado. */
        token = ultimo ? hexDeByte(b) : String.fromCharCode(b);
      } else if (b >= 33 && b <= 126 && b !== 61) {
        token = String.fromCharCode(b);
      } else {
        token = hexDeByte(b);
      }

      /* 76 é o teto da linha e o '=' de continuação precisa caber nela; a
         sequência '=XX' jamais é partida ao meio. */
      if (atual.length + token.length > 75) {
        saida.push(`${atual}=`);
        atual = '';
      }
      atual += token;
    }
    saida.push(atual);
  }

  return saida.join(CRLF);
}

const ENTIDADES = [
  [/&nbsp;/gi, ' '], [/&lt;/gi, '<'], [/&gt;/gi, '>'],
  [/&quot;/gi, '"'], [/&#0?39;/gi, "'"], [/&apos;/gi, "'"],
  /* '&amp;' por último: senão '&amp;lt;' viraria '<' em vez de '&lt;'. */
  [/&amp;/gi, '&']
];

/**
 * Versão em texto puro do HTML, para o cliente que não renderiza HTML e para
 * os filtros de spam, que desconfiam de mensagem só-HTML.
 */
function textoDeHtml(html) {
  let t = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  for (const [de, para] of ENTIDADES) t = t.replace(de, para);

  return t
    .replace(/[^\S\n]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ==========================================================================
   4. MIME
   ========================================================================== */

/**
 * Fronteira aleatória. O prefixo '=_' não aparece em base64 nem no meio de uma
 * linha quoted-printable, e 24 bytes de crypto tornam a coincidência com o
 * conteúdo improvável — mesmo assim quem chama confere, porque uma fronteira
 * que apareça no corpo parte a mensagem em duas.
 */
const novaFronteira = () => `=_Phygital_${crypto.randomBytes(24).toString('hex')}`;

function fronteiraLivreDe(...textos) {
  for (let tentativa = 0; tentativa < 8; tentativa += 1) {
    const f = novaFronteira();
    if (!textos.some((t) => String(t).includes(f))) return f;
  }
  throw new Error('Não consegui gerar uma fronteira MIME que não colidisse com o conteúdo.');
}

/** Uma parte MIME: cabeçalhos, linha em branco, corpo. */
const parte = (cabecalhos, corpo) => `${cabecalhos.join(CRLF)}${CRLF}${CRLF}${corpo}`;

/**
 * Junta as partes numa multipart. O CRLF que antecede cada fronteira pertence
 * ao delimitador, não ao corpo da parte (RFC 2046) — por isso as partes não
 * terminam em quebra de linha.
 */
function corpoMultipart(fronteira, partes) {
  let corpo = '';
  for (const p of partes) corpo += `--${fronteira}${CRLF}${p}${CRLF}`;
  return `${corpo}--${fronteira}--`;
}

/** Percent-encoding do RFC 2231 (parecido com URL, mas com outro conjunto seguro). */
function percent(texto) {
  return [...Buffer.from(String(texto), 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/**
 * Parâmetro de nome de arquivo. Com acento vão os dois: a forma antiga entre
 * aspas, sem acento, para o cliente velho não ficar sem nome nenhum, e a forma
 * estendida do RFC 2231, que é a que preserva "Relatório final.pdf".
 */
function parametrosDeNome(chave, nome) {
  const limpo = umaLinha(nome).replace(/[/\\]/g, '_') || 'arquivo';

  if (SO_ASCII_IMPRIMIVEL.test(limpo) && !/["\\]/.test(limpo)) {
    return [`${chave}="${limpo}"`];
  }

  const reserva = limpo
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   /* "ó" vira "o", não "_" */
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');

  return [`${chave}="${reserva}"`, `${chave}*=UTF-8''${percent(limpo)}`];
}

/** Conteúdo do anexo como Buffer. String vale como texto, salvo base64 declarado. */
function conteudoDeAnexo(anexo) {
  const c = anexo && anexo.conteudo;
  if (Buffer.isBuffer(c)) return c;
  if (ArrayBuffer.isView(c)) return Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  if (c instanceof ArrayBuffer) return Buffer.from(c);
  if (typeof c === 'string') {
    return Buffer.from(c, String(anexo.codificacao || '').toLowerCase() === 'base64' ? 'base64' : 'utf8');
  }
  return Buffer.alloc(0);
}

function parteAnexo(anexo) {
  const nome = umaLinha(anexo && anexo.nome) || 'arquivo';
  const tipo = umaLinha(anexo && anexo.tipo).replace(/[;\s]/g, '') || 'application/octet-stream';

  return parte([
    dobrarParametros('Content-Type', tipo, parametrosDeNome('name', nome)),
    'Content-Transfer-Encoding: base64',
    dobrarParametros('Content-Disposition', 'attachment', parametrosDeNome('filename', nome))
  ], base64Quebrado(conteudoDeAnexo(anexo)));
}

/**
 * Monta a mensagem inteira, cabeçalhos e corpo, pronta para o DATA.
 *
 * Estrutura:
 *   sem anexo → multipart/alternative { text/plain, text/html }
 *   com anexo → multipart/mixed { multipart/alternative, anexo, anexo... }
 *
 * A ordem texto→HTML dentro da alternative não é estética: o cliente exibe a
 * ÚLTIMA parte que sabe entender, então o HTML tem que vir depois.
 *
 * Só existe a parte de texto quando não há HTML nenhum — inventar HTML aqui
 * duplicaria o trabalho de email.js, que é quem monta o layout da marca.
 *
 * @param {{ de, para, responderPara, assunto, html, texto, anexos, data, idMensagem }} mensagem
 * @returns {string} mensagem MIME completa, com CRLF em tudo
 */
function montarMime(mensagem = {}) {
  const de = pessoa(mensagem.de);
  if (!de) throw new Error('Mensagem sem remetente: informe `de`.');

  const destinatarios = listaDePessoas(mensagem.para);
  if (!destinatarios.length) throw new Error('Mensagem sem destinatário: informe `para`.');

  const responderPara = pessoa(mensagem.responderPara);
  const html = mensagem.html === null || mensagem.html === undefined ? '' : String(mensagem.html);
  const texto = mensagem.texto === null || mensagem.texto === undefined || mensagem.texto === ''
    ? textoDeHtml(html)
    : String(mensagem.texto);

  const anexos = Array.isArray(mensagem.anexos) ? mensagem.anexos.filter(Boolean) : [];

  /* Partes de conteúdo. */
  const partePlano = parte([
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable'
  ], quotedPrintable(texto));

  const parteHtml = html ? parte([
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ], base64Quebrado(html)) : null;

  const partesAnexo = anexos.map(parteAnexo);

  let tipoRaiz;
  let parametrosRaiz;
  let corpo;

  if (parteHtml) {
    const alternativa = fronteiraLivreDe(partePlano, parteHtml);
    const corpoAlternativa = corpoMultipart(alternativa, [partePlano, parteHtml]);

    if (partesAnexo.length) {
      const mista = fronteiraLivreDe(corpoAlternativa, ...partesAnexo);
      tipoRaiz = 'multipart/mixed';
      parametrosRaiz = [`boundary="${mista}"`];
      corpo = corpoMultipart(mista, [
        parte([dobrarParametros('Content-Type', 'multipart/alternative', [`boundary="${alternativa}"`])],
          corpoAlternativa),
        ...partesAnexo
      ]);
    } else {
      tipoRaiz = 'multipart/alternative';
      parametrosRaiz = [`boundary="${alternativa}"`];
      corpo = corpoAlternativa;
    }
  } else if (partesAnexo.length) {
    const mista = fronteiraLivreDe(partePlano, ...partesAnexo);
    tipoRaiz = 'multipart/mixed';
    parametrosRaiz = [`boundary="${mista}"`];
    corpo = corpoMultipart(mista, [partePlano, ...partesAnexo]);
  } else {
    /* Mensagem só de texto: multipart de uma parte só seria invólucro à toa. */
    tipoRaiz = 'text/plain';
    parametrosRaiz = ['charset="UTF-8"'];
    corpo = quotedPrintable(texto);
  }

  const cabecalhos = [
    dobrarLista('From', [formatarPessoa(de)]),
    dobrarLista('To', destinatarios.map(formatarPessoa)),
    ...(responderPara ? [dobrarLista('Reply-To', [formatarPessoa(responderPara)])] : []),
    dobrarTexto('Subject', codificarCabecalho(mensagem.assunto)),
    `Date: ${dataRfc5322(mensagem.data)}`,
    `Message-ID: ${umaLinha(mensagem.idMensagem) || novoIdMensagem(de.endereco)}`,
    'MIME-Version: 1.0',
    dobrarParametros('Content-Type', tipoRaiz, parametrosRaiz),
    ...(tipoRaiz === 'text/plain' ? ['Content-Transfer-Encoding: quoted-printable'] : [])
  ];

  return `${cabecalhos.join(CRLF)}${CRLF}${CRLF}${corpo}`;
}

/**
 * Prepara o corpo do DATA.
 *
 * DOT-STUFFING (RFC 5321 §4.5.2): dentro do DATA, uma linha com um ponto
 * sozinho ENCERRA a mensagem. Todo ponto no começo de linha vira dois e o
 * servidor desfaz do outro lado. Sem isso, um corpo que contenha uma linha "."
 * — coisa que sai naturalmente do texto puro de um HTML — é cortado ao meio e o
 * resto vira comando SMTP inválido.
 */
function corpoDeData(mime) {
  const normalizado = String(mime)
    .replace(/\r\n|\r|\n/g, CRLF)
    .replace(/(?:\r\n)+$/, '');

  const linhas = normalizado.split(CRLF).map((l) => (l.startsWith('.') ? `.${l}` : l));
  return `${linhas.join(CRLF)}${CRLF}.${CRLF}`;
}

/* ==========================================================================
   5. PROTOCOLO
   ========================================================================== */

/* Erro de TLS que não melhora sozinho: repetir o envio não conserta um
   certificado errado, então é falha permanente e o despachante não deve tentar
   de novo — tem que aparecer para um humano. */
const TLS_SEM_VOLTA = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_HANDSHAKE_TIMEOUT'
]);

/**
 * Erro do módulo. `temporario` é o que o despachante lê para decidir retry:
 * 4xx e queda de rede voltam depois, 5xx e certificado inválido não voltam.
 */
function erroSmtp(mensagem, { codigo = 0, etapa = null, temporario = false, dialogo = null } = {}) {
  const e = new Error(mensagem);
  e.name = 'ErroSmtp';
  e.codigo = codigo;
  e.etapa = etapa;
  e.temporario = Boolean(temporario);
  e.permanente = !e.temporario;
  if (dialogo) e.dialogo = dialogo;
  return e;
}

/** Falha de soquete ou de TLS — nunca carrega credencial, só o código do Node. */
function erroRede(causa, etapa) {
  const codigo = causa && causa.code ? String(causa.code) : '';
  const detalhe = codigo || (causa && causa.message) || 'motivo desconhecido';

  return erroSmtp(
    `Falha de conexão com o servidor de e-mail${etapa ? ` em ${etapa}` : ''}: ${detalhe}.`,
    { etapa, temporario: !TLS_SEM_VOLTA.has(codigo) }
  );
}

/** Resposta fora de 2xx/3xx. 4xx volta depois; 5xx só com intervenção. */
function erroDeResposta(resposta, etapa, conversa) {
  return erroSmtp(
    `O servidor de e-mail recusou ${etapa}: ${resposta.codigo} ${resposta.texto}`.trim(),
    {
      codigo: resposta.codigo,
      etapa,
      temporario: resposta.codigo >= 400 && resposta.codigo < 500,
      dialogo: conversa ? conversa.dialogo() : null
    }
  );
}

const respostaBoa = (r) => r.codigo >= 200 && r.codigo < 400;

function exigir(resposta, etapa, conversa) {
  if (respostaBoa(resposta)) return resposta;
  throw erroDeResposta(resposta, etapa, conversa);
}

/**
 * A conversa com o servidor: lê resposta por LINHA e junta as continuações.
 *
 * Formato da resposta (RFC 5321 §4.2): '250-Texto' continua, '250 Texto'
 * encerra. Ler por chunk de soquete em vez de por linha é o erro clássico aqui
 * — um EHLO chega partido em dois pacotes e um pacote pode trazer duas
 * respostas grudadas.
 */
function criarConversa(socket, { timeoutMs }, registro = []) {
  const decodificador = new StringDecoder('utf8');
  const prontas = [];

  let sobra = '';
  let acumuladas = [];
  let esperando = null;
  let falha = null;

  const anotar = (linha) => {
    registro.push(linha);
    if (registro.length > DIALOGO_MAX) registro.shift();
  };

  function concluir(resposta) {
    if (!esperando) { prontas.push(resposta); return; }
    const alvo = esperando;
    esperando = null;
    clearTimeout(alvo.relogio);
    alvo.resolver(resposta);
  }

  function romper(erro) {
    falha = falha || erro;
    if (!esperando) return;
    const alvo = esperando;
    esperando = null;
    clearTimeout(alvo.relogio);
    alvo.rejeitar(falha);
  }

  function aoReceber(pedaco) {
    sobra += decodificador.write(pedaco);
    let corte;

    while ((corte = sobra.indexOf('\n')) !== -1) {
      let linha = sobra.slice(0, corte);
      sobra = sobra.slice(corte + 1);
      if (linha.endsWith('\r')) linha = linha.slice(0, -1);

      acumuladas.push(linha);
      anotar(`< ${linha}`);

      /* Só a linha SEM o hífen na quarta posição fecha a resposta. */
      if (linha.length >= 4 && linha[3] === '-') continue;

      const codigo = Number(linha.slice(0, 3));
      concluir({
        codigo: Number.isFinite(codigo) ? codigo : 0,
        linhas: acumuladas,
        texto: acumuladas.map((l) => l.slice(4)).join(' ').trim()
      });
      acumuladas = [];
    }
  }

  const aoErrar = (e) => romper(erroRede(e, 'a leitura da resposta'));
  const aoFechar = () => romper(erroSmtp(
    'A conexão com o servidor de e-mail caiu antes do fim da conversa.',
    { temporario: true }
  ));

  socket.on('data', aoReceber);
  socket.on('error', aoErrar);
  socket.on('close', aoFechar);

  return {
    dialogo: () => registro.slice(),

    /** Solta os ouvintes — obrigatório antes de embrulhar o soquete em TLS. */
    soltar() {
      socket.removeListener('data', aoReceber);
      socket.removeListener('error', aoErrar);
      socket.removeListener('close', aoFechar);
    },

    ler(etapa) {
      if (prontas.length) return Promise.resolve(prontas.shift());
      if (falha) return Promise.reject(falha);

      return new Promise((resolver, rejeitar) => {
        const relogio = setTimeout(() => {
          esperando = null;
          rejeitar(erroSmtp(
            `O servidor de e-mail não respondeu em ${Math.round(timeoutMs / 1000)}s (${etapa}).`,
            { etapa, temporario: true, dialogo: registro.slice() }
          ));
        }, timeoutMs);

        /* Um temporizador solto adia o fim do processo; unref evita isso. */
        if (relogio.unref) relogio.unref();
        esperando = { resolver, rejeitar, relogio };
      });
    },

    /**
     * Escreve no soquete. `rotulo` é o que vai para o diálogo de diagnóstico —
     * é aqui que a credencial é substituída por asteriscos, ANTES de existir
     * qualquer cópia dela em memória de log.
     */
    escrever(dados, rotulo) {
      anotar(`> ${rotulo === undefined ? String(dados).replace(/\r\n$/, '') : rotulo}`);

      /* write devolve false quando o buffer encheu: com anexo grande, seguir
         escrevendo sem esperar o dreno acumula a mensagem inteira na memória. */
      if (socket.write(dados)) return Promise.resolve();

      return new Promise((pronto) => {
        const seguir = () => {
          socket.removeListener('drain', seguir);
          socket.removeListener('close', seguir);
          pronto();
        };
        socket.once('drain', seguir);
        socket.once('close', seguir);
      });
    }
  };
}

async function comando(conversa, linha, etapa, rotulo) {
  await conversa.escrever(linha + CRLF, rotulo);
  return conversa.ler(etapa);
}

/**
 * Opções de TLS. rejectUnauthorized fica LIGADO sempre.
 *
 * permitirCertificadoInvalido é escape para ambiente interno cujo servidor usa
 * certificado próprio (e para o servidor SMTP falso dos testes). Vem desligado,
 * e ligá-lo em produção derruba a proteção contra servidor no meio do caminho —
 * a senha seria entregue a quem atendesse a conexão.
 */
function opcoesTls(cfg) {
  /* `host` também vale para o STARTTLS, onde tls.connect recebe um soquete
     pronto e é por ele que confere o nome no certificado. */
  const opcoes = {
    host: cfg.host,
    rejectUnauthorized: !cfg.permitirCertificadoInvalido,
    minVersion: 'TLSv1.2'
  };

  /* SNI não aceita endereço IP (RFC 6066): mandá-lo faz o Node recusar a
     conexão antes de tentar. Servidor configurado por IP fica só sem SNI. */
  if (!net.isIP(cfg.host)) opcoes.servername = cfg.host;

  return opcoes;
}

function conectar(cfg) {
  return new Promise((resolver, rejeitar) => {
    /* Porta 465 é TLS implícito: a conexão já nasce cifrada, sem STARTTLS. */
    const socket = cfg.seguro
      ? tls.connect({ host: cfg.host, port: cfg.porta, ...opcoesTls(cfg) })
      : net.connect({ host: cfg.host, port: cfg.porta });

    const relogio = setTimeout(() => {
      socket.destroy();
      rejeitar(erroSmtp(
        `Sem resposta de ${cfg.host}:${cfg.porta} em ${Math.round(cfg.timeoutMs / 1000)}s.`,
        { etapa: 'a conexão', temporario: true }
      ));
    }, cfg.timeoutMs);
    if (relogio.unref) relogio.unref();

    const falhar = (e) => {
      clearTimeout(relogio);
      socket.destroy();
      rejeitar(erroRede(e, 'a conexão'));
    };

    socket.once('error', falhar);
    socket.once(cfg.seguro ? 'secureConnect' : 'connect', () => {
      clearTimeout(relogio);
      socket.removeListener('error', falhar);
      socket.setNoDelay(true);
      resolver(socket);
    });
  });
}

/** Embrulha o soquete já aberto em TLS, depois do 220 do STARTTLS. */
function elevarTls(socketBruto, cfg) {
  return new Promise((resolver, rejeitar) => {
    const seguro = tls.connect({ socket: socketBruto, ...opcoesTls(cfg) });

    const relogio = setTimeout(() => {
      seguro.destroy();
      rejeitar(erroSmtp(
        `O TLS com ${cfg.host} não fechou em ${Math.round(cfg.timeoutMs / 1000)}s.`,
        { etapa: 'o STARTTLS', temporario: true }
      ));
    }, cfg.timeoutMs);
    if (relogio.unref) relogio.unref();

    const falhar = (e) => {
      clearTimeout(relogio);
      seguro.destroy();
      rejeitar(erroRede(e, 'o STARTTLS'));
    };

    seguro.once('error', falhar);
    seguro.once('secureConnect', () => {
      clearTimeout(relogio);
      seguro.removeListener('error', falhar);
      resolver(seguro);
    });
  });
}

/** Extensões anunciadas no EHLO, indexadas pelo nome em maiúsculas. */
function extensoesDe(resposta) {
  const tabela = new Map();

  /* A primeira linha do EHLO é a saudação do servidor, não uma extensão. */
  for (const linha of resposta.linhas.slice(1)) {
    const conteudo = linha.slice(4).trim();
    if (!conteudo) continue;
    const [chave, ...resto] = conteudo.split(/\s+/);
    tabela.set(chave.toUpperCase(), resto.join(' '));
  }
  return tabela;
}

async function saudar(conversa, cfg) {
  const ehlo = await comando(conversa, `EHLO ${cfg.nomeLocal}`, 'o EHLO');
  if (respostaBoa(ehlo)) return extensoesDe(ehlo);

  /* Servidor antigo que só fala HELO: segue sem extensão nenhuma, e quem
     depender de STARTTLS ou AUTH falha logo adiante com mensagem própria. */
  exigir(await comando(conversa, `HELO ${cfg.nomeLocal}`, 'o HELO'), 'o HELO', conversa);
  return new Map();
}

/* Recusa que indica mecanismo não suportado, e não credencial errada: só nesses
   casos vale insistir com o outro mecanismo. Repetir depois de um 535 apenas
   soma mais uma tentativa falha ao contador de bloqueio do provedor. */
const CODIGOS_DE_MECANISMO = new Set([501, 504, 538]);

async function autenticarPlain(conversa, cfg) {
  /* RFC 4616: <NUL>usuario<NUL>senha em base64, tudo numa linha só. */
  const credencial = Buffer.from(`\0${cfg.usuario}\0${cfg.senha}`, 'utf8').toString('base64');
  await conversa.escrever(`AUTH PLAIN ${credencial}${CRLF}`, 'AUTH PLAIN ********');
  return conversa.ler('a autenticação');
}

async function autenticarLogin(conversa, cfg) {
  /* AUTH LOGIN é conversado: o servidor pede usuário e senha em passos
     separados, cada um respondido com base64 puro. */
  const inicio = await comando(conversa, 'AUTH LOGIN', 'a autenticação');
  if (inicio.codigo !== 334) return inicio;

  await conversa.escrever(`${Buffer.from(cfg.usuario, 'utf8').toString('base64')}${CRLF}`,
    '******** (usuário)');
  const pediuSenha = await conversa.ler('a autenticação');
  if (pediuSenha.codigo !== 334) return pediuSenha;

  await conversa.escrever(`${Buffer.from(cfg.senha, 'utf8').toString('base64')}${CRLF}`,
    '******** (senha)');
  return conversa.ler('a autenticação');
}

async function autenticar(conversa, cfg, extensoes) {
  /* Relay interno sem credencial: não há o que apresentar. */
  if (!cfg.usuario) return false;

  if (!cfg.senha) {
    throw erroSmtp(
      'A senha do SMTP não está configurada: defina PHYGITAL_SMTP_SENHA no ambiente.',
      { etapa: 'a autenticação' }
    );
  }

  if (!extensoes.has('AUTH')) {
    throw erroSmtp(
      `O servidor ${cfg.host}:${cfg.porta} não anunciou AUTH no EHLO: não há como autenticar `
      + `${cfg.usuario}. Confira a porta e a forma de segurança configuradas.`,
      { etapa: 'a autenticação' }
    );
  }

  const mecanismos = String(extensoes.get('AUTH') || '').toUpperCase().split(/\s+/).filter(Boolean);

  if (mecanismos.includes('PLAIN')) {
    const r = await autenticarPlain(conversa, cfg);
    if (respostaBoa(r)) return true;
    if (!(CODIGOS_DE_MECANISMO.has(r.codigo) && mecanismos.includes('LOGIN'))) {
      throw erroDeResposta(r, 'a autenticação', conversa);
    }
  }

  if (mecanismos.includes('LOGIN')) {
    exigir(await autenticarLogin(conversa, cfg), 'a autenticação', conversa);
    return true;
  }

  throw erroSmtp(
    `O servidor ${cfg.host} só aceita ${mecanismos.join(', ') || 'mecanismos desconhecidos'}; `
    + 'este cliente fala PLAIN e LOGIN.',
    { etapa: 'a autenticação' }
  );
}

/** Abre a conexão, cifra, cumprimenta e autentica. Preenche `estado` no caminho. */
async function handshake(cfg, estado) {
  /* O registro do diálogo é do ESTADO, não da conversa: ele precisa atravessar
     a troca de soquete do STARTTLS, senão o diagnóstico perde justamente a
     metade em que o problema costuma estar. */
  estado.registro = estado.registro || [];

  estado.socket = await conectar(cfg);
  estado.conversa = criarConversa(estado.socket, cfg, estado.registro);
  estado.cifrado = cfg.seguro;

  const banner = exigir(await estado.conversa.ler('a abertura da conexão'),
    'a abertura da conexão', estado.conversa);
  estado.banner = banner.linhas[0] || '';

  estado.extensoes = await saudar(estado.conversa, cfg);

  if (!cfg.seguro) {
    if (!estado.extensoes.has('STARTTLS')) {
      /* Sem STARTTLS a senha viajaria em claro. Preferimos falhar. */
      throw erroSmtp(
        `O servidor ${cfg.host}:${cfg.porta} não oferece STARTTLS. Enviar por aqui exporia a `
        + 'senha em texto puro; use a porta 465 (SSL) ou corrija o servidor.',
        { etapa: 'o STARTTLS' }
      );
    }

    exigir(await comando(estado.conversa, 'STARTTLS', 'o STARTTLS'), 'o STARTTLS', estado.conversa);

    /* Os ouvintes do soquete em claro precisam sair antes do embrulho, senão
       continuariam consumindo os bytes que agora pertencem ao TLS. */
    estado.conversa.soltar();
    estado.socket = await elevarTls(estado.socket, cfg);
    estado.conversa = criarConversa(estado.socket, cfg, estado.registro);
    estado.cifrado = true;

    /* O segundo EHLO é obrigatório (RFC 3207 §4.2): o que o servidor anunciou
       antes do STARTTLS não vale depois, e o AUTH costuma aparecer só agora. */
    estado.extensoes = await saudar(estado.conversa, cfg);
  }

  estado.autenticado = await autenticar(estado.conversa, cfg, estado.extensoes);
  return estado;
}

/**
 * Roda `tarefa` dentro de uma sessão SMTP completa e garante que o soquete
 * morre no fim — inclusive em erro, inclusive no timeout total.
 */
async function comSessao(cfg, tarefa) {
  const estado = {
    socket: null, conversa: null, extensoes: new Map(), registro: [],
    banner: '', cifrado: false, autenticado: false, expirou: false
  };

  /* Teto da conversa inteira, além do teto por etapa: um servidor que responde
     a cada passo com 29s de atraso nunca estouraria o timeout de etapa. */
  const relogioTotal = setTimeout(() => {
    estado.expirou = true;
    if (estado.socket) estado.socket.destroy();
  }, cfg.timeoutTotalMs);
  if (relogioTotal.unref) relogioTotal.unref();

  try {
    await handshake(cfg, estado);
    const resultado = await tarefa(estado);
    await comando(estado.conversa, 'QUIT', 'o QUIT').catch(() => { /* já estamos indo embora */ });
    return resultado;
  } catch (e) {
    if (estado.expirou) {
      throw erroSmtp(
        `A conversa com ${cfg.host} passou de ${Math.round(cfg.timeoutTotalMs / 1000)}s e foi interrompida.`,
        { etapa: 'a sessão', temporario: true }
      );
    }
    throw e;
  } finally {
    clearTimeout(relogioTotal);
    if (estado.conversa) estado.conversa.soltar();
    if (estado.socket) estado.socket.destroy();
  }
}

/* ==========================================================================
   6. API
   ========================================================================== */

/** Nome no EHLO: FQDN ou literal de endereço. Sanitizado — vai cru no comando. */
function nomeLocalSeguro(informado) {
  const bruto = umaLinha(informado || os.hostname() || '').replace(/[^A-Za-z0-9.\-[\]:]/g, '');
  return bruto && /[A-Za-z0-9]/.test(bruto) ? bruto.slice(0, 255) : '[127.0.0.1]';
}

/**
 * Normaliza a configuração. `seguro` só é deduzido da porta quando não vem
 * dito: 465 é TLS implícito, o resto (587, 25) abre em claro e sobe por
 * STARTTLS.
 */
function normalizarConfig(config = {}) {
  const host = umaLinha(config.host || config.servidor || config.servidorSaida || '');
  if (!host) throw erroSmtp('Servidor de saída não configurado.', { etapa: 'a configuração' });

  const porta = Number(config.porta || config.smtp) || 587;
  const timeoutMs = Math.max(Number(config.timeoutMs) || TIMEOUT_ETAPA, 1000);

  return {
    host,
    porta,
    seguro: config.seguro === undefined || config.seguro === null
      ? porta === 465
      : Boolean(config.seguro),
    usuario: umaLinha(config.usuario || ''),
    /* A senha não é normalizada nem aparada: espaço no fim pode ser parte dela. */
    senha: config.senha === undefined || config.senha === null ? '' : String(config.senha),
    remetente: enderecoLimpo(config.remetente || config.usuario || ''),
    nomeRemetente: umaLinha(config.nomeRemetente || ''),
    permitirCertificadoInvalido: config.permitirCertificadoInvalido === true,
    nomeLocal: nomeLocalSeguro(config.nomeLocal),
    timeoutMs,
    timeoutTotalMs: Math.max(
      Number(config.timeoutTotalMs) || timeoutMs * 10,
      TIMEOUT_TOTAL_MIN
    )
  };
}

/**
 * Entrega uma mensagem.
 *
 * Não lança quando o servidor apenas RECUSA destinatários — devolve
 * `{ ok: false, recusados }`, porque endereço errado de um time não é falha de
 * infraestrutura. Lança (com `.temporario`) quando a conexão, o TLS, o AUTH ou
 * o DATA falham: é o despachante que decide, por esse campo, se tenta de novo.
 *
 * @param   {object} config    { host, porta, seguro, usuario, senha, remetente,
 *                               nomeRemetente, timeoutMs }
 * @param   {object} mensagem  { de, para, responderPara, assunto, html, texto, anexos }
 * @returns {Promise<{ ok, resposta, aceitos, recusados, codigo, temporario, idMensagem }>}
 */
async function enviarMensagem(config, mensagem = {}) {
  const cfg = normalizarConfig(config);

  const de = pessoa(mensagem.de)
    || pessoa({ nome: cfg.nomeRemetente, endereco: cfg.remetente });
  if (!de) throw erroSmtp('Remetente não configurado: sem ele o servidor recusa o MAIL FROM.',
    { etapa: 'a montagem da mensagem' });

  const destinatarios = listaDePessoas(mensagem.para);
  if (!destinatarios.length) {
    throw erroSmtp('Mensagem sem destinatário válido.', { etapa: 'a montagem da mensagem' });
  }

  const idMensagem = umaLinha(mensagem.idMensagem) || novoIdMensagem(de.endereco);
  const mime = montarMime({ ...mensagem, de, para: destinatarios, idMensagem });

  /* Remetente do ENVELOPE (MAIL FROM), que não precisa ser o do cabeçalho: a
     maioria dos provedores exige que ele seja a própria conta autenticada, ou
     recusa o envio como falsificação. */
  const envelope = cfg.remetente || de.endereco;

  return comSessao(cfg, async (estado) => {
    const { conversa } = estado;

    exigir(await comando(conversa, `MAIL FROM:<${envelope}>`, 'o remetente'), 'o remetente', conversa);

    const aceitos = [];
    const recusados = [];

    /* Um RCPT TO por destinatário: é assim que dá para saber QUEM foi recusado.
       Mandar todos de uma vez não existe no protocolo. */
    for (const destinatario of destinatarios) {
      const r = await comando(conversa, `RCPT TO:<${destinatario.endereco}>`, 'um destinatário');

      if (respostaBoa(r)) {
        aceitos.push(destinatario.endereco);
      } else {
        recusados.push({
          endereco: destinatario.endereco,
          codigo: r.codigo,
          motivo: r.texto,
          /* 4xx é caixa cheia ou greylisting: volta depois. 5xx não existe. */
          temporario: r.codigo >= 400 && r.codigo < 500
        });
      }
    }

    if (!aceitos.length) {
      /* Sem ninguém para receber não há DATA a mandar; RSET limpa a transação
         para o QUIT sair de uma conexão em estado válido. */
      await comando(conversa, 'RSET', 'o RSET').catch(() => { /* vamos fechar de todo jeito */ });

      return {
        ok: false,
        resposta: `Nenhum dos ${recusados.length} destinatário(s) foi aceito pelo servidor.`,
        codigo: recusados[0].codigo,
        aceitos,
        recusados,
        temporario: recusados.every((r) => r.temporario),
        idMensagem
      };
    }

    /* 354 é o convite para mandar o corpo; qualquer outra coisa é recusa. */
    exigir(await comando(conversa, 'DATA', 'o DATA'), 'o DATA', conversa);

    const corpo = corpoDeData(mime);
    await conversa.escrever(corpo, `[mensagem de ${Buffer.byteLength(corpo, 'utf8')} bytes]`);

    const fim = exigir(await conversa.ler('a entrega'), 'a entrega', conversa);

    return {
      ok: true,
      resposta: `${fim.codigo} ${fim.texto}`.trim(),
      codigo: fim.codigo,
      aceitos,
      /* Pode haver recusado mesmo com ok: um endereço errado numa lista de dez
         não impede a entrega dos outros nove. */
      recusados,
      temporario: false,
      idMensagem
    };
  });
}

/**
 * Testa a configuração sem entregar nada: conecta, cifra, EHLO, AUTH e sai.
 *
 * Não lança de propósito — é o que o botão "testar configuração" do painel
 * chama, e ali um diagnóstico legível vale mais do que uma exceção. A senha
 * nunca aparece no retorno; o diálogo já vem com a credencial mascarada.
 *
 * @returns {Promise<{ ok, banner, extensoes, cifrado, autenticado, erro, dialogo }>}
 */
async function verificarConexao(config) {
  let cfg;
  try {
    cfg = normalizarConfig(config);
  } catch (e) {
    return { ok: false, banner: '', extensoes: [], cifrado: false, autenticado: false,
      erro: e.message, codigo: 0, temporario: false, dialogo: [] };
  }

  const estado = { socket: null, conversa: null, extensoes: new Map(), registro: [], banner: '' };
  const listar = () => [...estado.extensoes].map(([c, v]) => (v ? `${c} ${v}` : c));

  try {
    await handshake(cfg, estado);
    await comando(estado.conversa, 'QUIT', 'o QUIT').catch(() => { /* já validou */ });

    return {
      ok: true,
      banner: estado.banner,
      extensoes: listar(),
      cifrado: estado.cifrado,
      autenticado: estado.autenticado,
      erro: null,
      codigo: 0,
      temporario: false,
      dialogo: estado.registro.slice()
    };
  } catch (e) {
    return {
      ok: false,
      banner: estado.banner || '',
      extensoes: listar(),
      cifrado: Boolean(estado.cifrado),
      autenticado: false,
      erro: e.message,
      codigo: Number(e.codigo) || 0,
      temporario: Boolean(e.temporario),
      dialogo: estado.registro.slice()
    };
  } finally {
    if (estado.conversa) estado.conversa.soltar();
    if (estado.socket) estado.socket.destroy();
  }
}

module.exports = {
  enviarMensagem, montarMime, verificarConexao,

  /* Expostos para teste e para quem for escrever o despachante. */
  normalizarConfig, corpoDeData, textoDeHtml, quotedPrintable, base64Quebrado,
  codificarCabecalho, dobrarTokens, pessoa, listaDePessoas, enderecoLimpo, umaLinha,
  dataRfc5322, novoIdMensagem, erroSmtp
};
