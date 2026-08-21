/* ==========================================================================
   PHYGITAL BRASIL — CAMINHO ÚNICO DE E-MAIL

   O briefing é explícito: existe UMA configuração de SMTP e UM caminho de
   envio. Toda notificação do sistema (confirmação de inscrição, mudança de
   status, protocolo de chamado, código de verificação, disparo em massa)
   passa por enviar() daqui. Nenhum outro módulo deve falar de e-mail.

   Sem senha de SMTP no ambiente nada sai de verdade: o envio é gravado em
   emails_enviados com status='simulado' para poder ser inspecionado nos
   testes. Havendo servidor de saída configurado E PHYGITAL_SMTP_SENHA, a linha
   nasce com status='fila' e quem transmite é server/fila-email.js, fora das
   transações de negócio.

   Decisões que valem explicar:

   · O corpo é HTML. Todo valor substituído em {{...}} é escapado, senão um
     nome de time como "Real <b>Madruga" quebraria o layout e, pior, abriria
     injeção de HTML no e-mail de terceiros.
   · O assunto NÃO é escapado (vira cabeçalho, não HTML) — mas tem quebra de
     linha removida, que é o vetor de injeção de cabeçalho equivalente. O
     escape do assunto acontece só na hora de embuti-lo no HTML da prévia.
   · Variável sem valor vira string vazia. Deixar '{{usuario.nome}}' aparecer
     num e-mail enviado ao competidor é pior do que a lacuna.
   · enviar() nunca lança. É chamada pendurada em transações de negócio
     (inscrever um time, abrir um chamado) e uma falha de e-mail não pode
     desfazer a operação — a falha vira uma linha com status='falhou',
     visível no histórico e nos testes.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const mapa = require('./mapa');
const traducoes = require('./traducoes');
const { erro404 } = require('./http');

/* Base para montar a URL absoluta do logo: cliente de e-mail não resolve
   caminho relativo. */
/* Endereço público onde as imagens do e-mail carregam. Um localhost dentro do
   HTML enviado quebra o logo para quem recebe.

   - PHYGITAL_URL vence tudo, para produção em domínio próprio;
   - Codespaces injeta CODESPACE_NAME em todo shell — traduzido para a URL
     encaminhada, faz o e-mail funcionar sem configuração extra;
   - o padrão local vale para desenvolvimento na máquina do autor. */
const URL_BASE = process.env.PHYGITAL_URL
  || (process.env.CODESPACE_NAME
      && `https://${process.env.CODESPACE_NAME}-${process.env.PHYGITAL_PORTA || 3000}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`)
  || 'http://localhost:3000';

/* Assunto longo é cortado pelo cliente de e-mail de qualquer jeito. */
const ASSUNTO_MAX = 200;

/* Rodapé fixo do modelo, conforme o briefing (logo, assunto, corpo, rodapé). */
const REMETENTE_PADRAO = 'Esportes Phygital Brasil';
const CONTATO = 'contato@phygitalgamesbr.com.br · São Paulo, SP';

/* --------------------------------------------------------------------------
   VARIÁVEIS OBRIGATÓRIAS POR MODELO

   Regra de negócio, não de tela: há modelos que perdem a função se o admin
   apagar a variável ao editar o texto. Um e-mail de código de verificação sem
   {{codigo}} é inútil; uma confirmação de inscrição sem {{inscricao.protocolo}}
   contraria o briefing, que exige o protocolo na primeira mensagem.
   -------------------------------------------------------------------------- */

const VARIAVEIS_OBRIGATORIAS = {
  'codigo-verificacao': ['{{codigo}}'],
  'senha-recuperacao': ['{{codigo}}'],
  'inscricao-confirmada': ['{{inscricao.protocolo}}', '{{campeonato.nome}}'],
  'lista-oficial': ['{{campeonato.nome}}'],
  'lista-espera': ['{{campeonato.nome}}'],
  'inscricoes-encerrando': ['{{campeonato.encerramento}}'],
  'chamado-aberto': ['{{chamado.protocolo}}'],
  'chamado-respondido': ['{{chamado.protocolo}}'],
  'chamado-encerrado': ['{{chamado.protocolo}}'],
  'adm-nova-inscricao': ['{{campeonato.nome}}'],
  'adm-novo-chamado': ['{{chamado.protocolo}}'],
  'adm-inscricoes-encerradas': ['{{campeonato.nome}}']
};

/* O briefing manda a primeira mensagem dizer, com todas as letras, que
   confirma o RECEBIMENTO e não garante vaga. Não dá para validar prosa, mas dá
   para avisar quando a expressão some do texto. */
const RESSALVA_INSCRICAO = 'não garante vaga';

/* --------------------------------------------------------------------------
   SUBSTITUIÇÃO DE VARIÁVEIS
   -------------------------------------------------------------------------- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapar = (v) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const MARCADOR = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * Resolve 'campeonato.nome' dentro do contexto.
 * Só propriedade própria: sem isso, {{constructor.name}} ou {{__proto__.x}}
 * alcançariam o protótipo e vazariam coisa que não é dado do e-mail.
 */
function doContexto(contexto, caminho) {
  let no = contexto;
  for (const parte of caminho.split('.')) {
    if (no === null || typeof no !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(no, parte)) return undefined;
    no = no[parte];
  }
  return no;
}

/**
 * Troca os {{...}} pelos valores do contexto.
 *
 * O replace com função faz UMA passada e não reexamina o que foi inserido:
 * um valor que por acaso contenha '{{codigo}}' entra literal, sem virar uma
 * segunda substituição.
 */
function substituir(texto, contexto, { html = true } = {}) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(MARCADOR, (_, caminho) => {
      const valor = doContexto(contexto, caminho);
      if (valor === undefined || valor === null || valor === '') return '';
      return html ? escapar(valor) : String(valor);
    });
}

/** Cabeçalho de e-mail é uma linha só: CR/LF aqui seria injeção de cabeçalho. */
function limparAssunto(texto) {
  return String(texto || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, ASSUNTO_MAX);
}

/**
 * Acrescenta ao contexto o que o sistema sabe sozinho, sem obrigar cada
 * chamador a lembrar: a data do envio e o servidor SMTP configurado.
 */
function contextoCompleto(contexto = {}) {
  const cfg = db.um('SELECT * FROM smtp WHERE id = 1');

  return {
    ...contexto,
    data: contexto.data || mapa.dataHora(db.agora()),
    smtp: {
      servidor: cfg ? cfg.servidor_saida : '',
      remetente: cfg ? cfg.remetente : REMETENTE_PADRAO,
      ...(contexto.smtp || {})
    }
  };
}

/* --------------------------------------------------------------------------
   IDIOMA DO DESTINATÁRIO

   O modelo tem UM id e UMA linha; assunto e corpo em inglês e espanhol ficam na
   tabela `traducoes` (tabela='modelos_email'). Duplicar a linha por idioma
   quebraria toda referência a modelo por id — inclusive a chave estrangeira de
   emails_enviados.
   -------------------------------------------------------------------------- */

/**
 * Idioma da conta que vai receber. Endereço que não é de nenhuma conta (o
 * disparo em massa aceita lista digitada) cai no português.
 */
function idiomaDoDestinatario(enderecos) {
  for (const endereco of enderecos || []) {
    const conta = db.um(
      'SELECT idioma FROM contas WHERE lower(email) = ? AND arquivado_em IS NULL',
      String(endereco).trim().toLowerCase()
    );
    if (conta) return traducoes.normalizarOuPadrao(conta.idioma);
  }
  return traducoes.IDIOMA_PADRAO;
}

/**
 * Aplica um modelo de e-mail ao contexto.
 * @param idioma  idioma do destinatário; campo sem tradução volta em português
 * @returns {{ id, para, ativo, assunto, corpo }} — corpo já em HTML seguro.
 */
function aplicarModelo(modeloId, contexto = {}, idioma = traducoes.IDIOMA_PADRAO) {
  const bruto = db.um('SELECT * FROM modelos_email WHERE id = ?', modeloId);
  if (!bruto) throw erro404(`Modelo de e-mail não encontrado: ${modeloId}.`);

  /* A troca acontece antes da substituição das variáveis: o {{...}} do texto
     traduzido é resolvido igual ao do português. */
  const modelo = traducoes.traduzir('modelos_email', bruto, idioma);

  const ctx = contextoCompleto(contexto);

  return {
    id: modelo.id,
    para: modelo.para,
    ativo: db.bool(modelo.ativo),
    /* Assunto vai como texto puro; o escape dele é responsabilidade de quem o
       coloca dentro de HTML (montarHtml). */
    assunto: limparAssunto(substituir(modelo.assunto, ctx, { html: false })),
    corpo: substituir(modelo.corpo, ctx)
  };
}

/** Variáveis ainda não substituídas — usado para avisar o admin na edição. */
function variaveisDe(texto) {
  const achadas = new Set();
  String(texto || '').replace(MARCADOR, (inteiro, caminho) => {
    achadas.add(`{{${caminho}}}`);
    return inteiro;
  });
  return [...achadas];
}

/* --------------------------------------------------------------------------
   MODELO FIXO DE APRESENTAÇÃO

   Briefing: logo, assunto, corpo, rodapé Phygital Brasil. Layout em tabela e
   estilo embutido porque cliente de e-mail ignora <style> e flex/grid.

   O logo colorido tem lettering branco e, pela regra da marca, só pode ir
   sobre fundo escuro — daí a faixa preta no topo. A fita tricolor abaixo dela
   é o dispositivo de assinatura da marca; três células de cor chapada
   sobrevivem onde gradiente CSS não sobrevive.
   -------------------------------------------------------------------------- */

const VERDE = '#009B4A';
const AMARELO = '#FCE001';
const AZUL = '#0A66B1';
const TINTA = '#0E1113';
const SUAVE = '#6E7377';
const FUNDO = '#F5F6F4';

function blocoAnexos(anexos) {
  if (!anexos || !anexos.length) return '';

  const itens = anexos.map((a) => {
    const nome = escapar(a && a.nome ? a.nome : 'arquivo');
    const kb = a && Number(a.tamanho) ? ` <span style="color:${SUAVE}">(${Math.ceil(Number(a.tamanho) / 1024)} KB)</span>` : '';
    return `<li style="margin:2px 0">${nome}${kb}</li>`;
  }).join('');

  return `<p style="margin:24px 0 4px;font-size:13px;color:${SUAVE}"><strong>Anexos</strong></p>`
    + `<ul style="margin:0;padding-left:18px;font-size:13px;color:${TINTA}">${itens}</ul>`;
}

/**
 * Monta o HTML final do e-mail. `corpo` já vem como HTML confiável (saiu de
 * substituir(), que escapou os valores) — não é escapado de novo aqui, senão
 * as tags do modelo virariam texto visível.
 */
function montarHtml({ assunto = '', corpo = '', anexos = [], rodape = '' } = {}) {
  const titulo = escapar(assunto);

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title></head>
<body style="margin:0;padding:24px 12px;background:${FUNDO};font-family:Barlow,Arial,Helvetica,sans-serif;color:${TINTA};line-height:1.6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden">

  <tr><td align="center" style="background:${TINTA};padding:26px 24px">
    <img src="${URL_BASE}/assets/img/logo/logo-colorido.png" alt="Phygital Brasil" width="180" style="display:block;border:0;width:180px;max-width:70%;height:auto">
  </td></tr>

  <tr><td style="padding:0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="33.33%" height="5" style="background:${VERDE};font-size:0;line-height:0">&nbsp;</td>
      <td width="33.33%" height="5" style="background:${AMARELO};font-size:0;line-height:0">&nbsp;</td>
      <td width="33.34%" height="5" style="background:${AZUL};font-size:0;line-height:0">&nbsp;</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:32px 32px 28px">
    <h1 style="margin:0 0 18px;font-family:Saira,'Arial Narrow',Arial,Helvetica,sans-serif;font-size:22px;line-height:1.25;letter-spacing:-0.02em;color:${TINTA}">${titulo}</h1>
    <div style="font-size:15px;color:${TINTA}">${corpo}</div>
    ${blocoAnexos(anexos)}
  </td></tr>

  <tr><td style="padding:20px 32px 28px;background:${FUNDO};font-size:12px;color:${SUAVE}">
    <strong style="color:${TINTA}">${escapar(REMETENTE_PADRAO)}</strong><br>
    ${escapar(CONTATO)}<br>
    ${rodape ? escapar(rodape) : 'Você recebe este e-mail porque é responsável por um time inscrito.'}
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/* --------------------------------------------------------------------------
   ANEXOS

   O binário fica em site/assets/enviados/ (a rota /api/upload já grava com
   assinatura conferida e nome no formato UUID.<ext>); a linha em
   emails_enviados guarda só o metadado, com o `caminho` como ponte. No momento
   de entregar, o dispatcher (server/fila-email.js) chama carregarAnexo() para
   abrir o arquivo do disco e entregar Buffer ao smtp.js — que já sabe montar
   multipart/mixed a partir de {nome, tipo, conteudo}.

   Duas travas:

   1. RESOLUÇÃO CONTIDA. path.resolve casa com a pasta PASTA_ENVIADOS e o
      resultado precisa começar por ela — caso o `caminho` que chegou não seja
      exatamente 'assets/enviados/<uuid>.<ext>', a rota já o descartou; aqui
      cinto e suspensório, para o dispatcher nunca abrir arquivo fora dali.
   2. NÃO LANÇA. Se o arquivo sumiu do disco (limpeza de órfãos, movido à mão),
      carregarAnexo devolve um erro em texto — quem chama transforma isso na
      coluna `erro` da linha e marca a mensagem como falha, em vez de derrubar
      a rodada do despachante.
   -------------------------------------------------------------------------- */

const PASTA_ENVIADOS = path.resolve(__dirname, '..', 'site', 'assets', 'enviados');
const CAMINHO_ENVIADO = /^assets\/enviados\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

/**
 * Lê o arquivo do anexo e devolve o que server/smtp.js pede.
 *
 * @param {{nome, tipo, caminho, tamanho}} a  metadado gravado no disparo
 * @returns {{ok:true, anexo}|{ok:false, motivo}}
 */
function carregarAnexo(a) {
  const nome = String((a && a.nome) || 'arquivo');
  const tipo = String((a && a.tipo) || 'application/octet-stream');
  const caminho = String((a && a.caminho) || '');

  if (!caminho) {
    /* Metadado sem caminho é anexo "só na prévia" — a rota nova exige o campo,
       mas o histórico velho pode ter linhas sem ele. Sinalizamos para o
       dispatcher entregar assim mesmo, sem esse anexo. */
    return { ok: false, motivo: `Anexo ${nome}: caminho não gravado.` };
  }

  /* Fora do padrão de /api/upload — o próprio /disparar descarta caminhos
     assim, mas repetimos a checagem no ponto que abre o arquivo. */
  if (!CAMINHO_ENVIADO.test(caminho)) {
    return { ok: false, motivo: `Anexo ${nome}: caminho fora do formato aceito.` };
  }

  const nomeArquivo = caminho.split('/').pop();
  const alvo = path.resolve(PASTA_ENVIADOS, nomeArquivo);

  /* Amarra final: o path resolvido tem que continuar DENTRO de site/assets/
     enviados. Sem o separador no fim, '/enviados-outro/x' bateria como prefixo. */
  if (alvo !== path.join(PASTA_ENVIADOS, nomeArquivo)
      || !alvo.startsWith(PASTA_ENVIADOS + path.sep)) {
    return { ok: false, motivo: `Anexo ${nome}: caminho fora da pasta de envios.` };
  }

  let conteudo;
  try {
    conteudo = fs.readFileSync(alvo);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, motivo: `Anexo ${nome}: arquivo sumiu de ${caminho}.` };
    }
    return { ok: false, motivo: `Anexo ${nome}: ${(e && e.message) || 'falha ao ler o arquivo.'}` };
  }

  return {
    ok: true,
    anexo: { nome, tipo, conteudo, codificacao: 'binary' }
  };
}

/* --------------------------------------------------------------------------
   ENVIO
   -------------------------------------------------------------------------- */

/**
 * Decide entre entrar na fila de envio real e apenas simular.
 *
 * O que decide é TER COMO ENVIAR: servidor de saída na tabela smtp e senha em
 * PHYGITAL_SMTP_SENHA. PHYGITAL_MODO não entra na conta — um servidor de
 * homologação com credencial válida precisa mandar e-mail de verdade, e a conta
 * de produção sem a senha no ambiente não pode fingir que mandou.
 *
 * Sem senha continua 'simulado', e é isso que permite rodar a suíte de testes
 * inteira sem mandar mensagem para pessoa nenhuma.
 *
 * O require é tardio de propósito: fila-email.js depende deste módulo, e
 * exigi-lo aqui em cima fecharia um ciclo de carregamento.
 */
function statusDeEnvio() {
  return require('./fila-email').configuracaoSmtp().ok ? 'fila' : 'simulado';
}

/** Normaliza destinatário: aceita string, lista, ou lista separada por vírgula. */
function normalizarPara(para) {
  if (!para) return [];
  const bruto = Array.isArray(para) ? para : String(para).split(/[\s,;]+/);
  const vistos = new Set();
  const saida = [];

  for (const item of bruto) {
    const e = String(item || '').trim();
    if (!e) continue;
    const chave = e.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(e);
  }
  return saida;
}

/**
 * Grava o envio. Único ponto de saída de e-mail do sistema.
 *
 * @param modeloId  id em modelos_email; assunto/corpo explícitos têm prioridade
 * @param para      endereço, lista de endereços ou string separada por vírgula
 * @param destino   rótulo do público ('Todos os campeonatos') para o histórico
 * @param contexto  valores das variáveis {{...}}
 * @param qtd       quantos destinatários; padrão = tamanho de `para`
 * @param idioma    força o idioma; sem ele, o da conta do primeiro destinatário
 * @returns registro gravado (nunca lança)
 */
function enviar({
  modeloId = null, para = null, destino = null, contexto = {},
  assunto = null, corpo = null, qtd = null, anexos = [], rodape = '',
  idioma = null
} = {}) {
  let assuntoFinal = assunto;
  let corpoFinal = corpo;
  let erro = null;

  /* Resolvido antes de aplicar o modelo: é ele que decide de qual idioma sai o
     assunto e o corpo. Quem chama pode forçar (o disparo em massa do painel
     manda no idioma escolhido pelo admin); sem isso, manda a preferência
     gravada na conta de quem recebe. */
  const enderecos = normalizarPara(para);
  const idiomaFinal = traducoes.normalizar(idioma) || idiomaDoDestinatario(enderecos);

  /* modelo_id tem chave estrangeira para modelos_email: gravar um id que não
     existe derrubaria justamente o registro de falha que queremos guardar.
     Só vai para a coluna depois que o modelo é encontrado de verdade. */
  let modeloGravavel = null;

  try {
    if (modeloId) {
      const aplicado = aplicarModelo(modeloId, contexto, idiomaFinal);
      modeloGravavel = aplicado.id;

      /* Modelo desativado pelo admin é decisão dele: não enviamos e não
         registramos falha, porque não houve falha nenhuma. */
      if (!aplicado.ativo) {
        return { ok: false, motivo: 'Modelo de e-mail desativado.', modeloId, registro: null };
      }

      if (!assuntoFinal) assuntoFinal = aplicado.assunto;
      if (!corpoFinal) corpoFinal = aplicado.corpo;
    } else {
      /* Sem modelo, assunto e corpo vieram do admin: as variáveis ainda são
         substituídas para o disparo em massa poder personalizar. */
      const ctx = contextoCompleto(contexto);
      assuntoFinal = limparAssunto(substituir(assuntoFinal, ctx, { html: false }));
      corpoFinal = substituir(corpoFinal, ctx);
    }
  } catch (e) {
    erro = e.message;
  }

  const html = montarHtml({ assunto: assuntoFinal || '', corpo: corpoFinal || '', anexos, rodape });

  let status = erro ? 'falhou' : statusDeEnvio();

  if (!erro && !enderecos.length && !destino) {
    /* Sem destinatário e sem rótulo de público não há o que entregar. */
    erro = 'Envio sem destinatário.';
    status = 'falhou';
  }

  /* PONTO DE INTEGRAÇÃO SMTP REAL.
     A linha é gravada como 'fila' e a transmissão fica com o despachante de
     server/fila-email.js, agendado logo abaixo do INSERT. enviar() continua
     SÍNCRONO e continua só gravando: é chamado de dentro de db.transacao() e
     uma sessão de SMTP presa não pode segurar o COMMIT nem, ao falhar,
     desfazer a inscrição de um time. Nenhum outro lugar do sistema envia. */

  const id = 'em-' + crypto.randomUUID();

  /* Só metadado: o binário fica em site/assets/enviados/ e o dispatcher lê o
     arquivo do disco na hora. Guardar o conteúdo em base64 aqui estouraria o
     histórico (100 MB por arquivo, e o painel imprime esta coluna). */
  const anexosGravaveis = Array.isArray(anexos)
    ? anexos.map((a) => ({
        nome: String((a && a.nome) || 'arquivo'),
        tipo: String((a && a.tipo) || 'application/octet-stream'),
        tamanho: Number(a && a.tamanho) || 0,
        /* Só grava o caminho quando ele existe: sem caminho, o dispatcher sabe
           que é anexo "só na prévia" e entrega a mensagem sem esse arquivo. */
        ...(a && a.caminho ? { caminho: String(a.caminho) } : {})
      }))
    : [];

  const linha = mapa.paraLinhaEmailEnviado({
    modeloId: modeloGravavel,
    assunto: assuntoFinal || '(sem assunto)',
    destino: destino || enderecos.join(', ') || null,
    para: enderecos.join(', ') || null,
    /* Guardamos o corpo, não o HTML inteiro: o histórico do painel imprime
       este campo como fragmento, e o envelope é sempre reconstituível por
       montarHtml(). */
    corpo: corpoFinal || '',
    qtd: qtd === null ? (enderecos.length || 1) : Number(qtd) || 0,
    status,
    erro,
    anexos: anexosGravaveis
  }, { id });

  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO emails_enviados (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );

  if (status === 'fila') {
    /* Próximo tick: o despacho começa depois que a transação desta chamada já
       fechou e a resposta HTTP já saiu. Se o despachante estiver indisponível
       por algum motivo, a linha simplesmente espera a próxima rodada — ela já
       está gravada, nada se perde. */
    try { require('./fila-email').agendar(); } catch (_) { /* fica na fila */ }
  }

  return {
    ok: status !== 'falhou',
    status,
    motivo: erro,
    id,
    modeloId,
    idioma: idiomaFinal,
    assunto: assuntoFinal || '',
    corpo: corpoFinal || '',
    html,
    destino: linha.destino,
    para: enderecos,
    qtd: linha.qtd,
    registro: mapa.emailEnviado(linha)
  };
}

/* --------------------------------------------------------------------------
   INSPEÇÃO (testes e painel)
   -------------------------------------------------------------------------- */

/** O que está esperando o despachante (server/fila-email.js). */
function fila() {
  return mapa.lista(
    db.todos("SELECT * FROM emails_enviados WHERE status = 'fila' ORDER BY data"),
    mapa.emailEnviado
  );
}

/** Últimos envios, do mais recente para o mais antigo. */
function ultimos(n = 20) {
  const limite = Math.min(Math.max(Number(n) || 20, 1), 500);
  return mapa.lista(
    db.todos('SELECT * FROM emails_enviados ORDER BY data DESC, id DESC LIMIT ?', limite),
    mapa.emailEnviado
  );
}

module.exports = {
  aplicarModelo, enviar, fila, ultimos,
  montarHtml, substituir, escapar, limparAssunto,
  variaveisDe, normalizarPara, statusDeEnvio, contextoCompleto,
  idiomaDoDestinatario, carregarAnexo,
  VARIAVEIS_OBRIGATORIAS, RESSALVA_INSCRICAO,
  PASTA_ENVIADOS
};
