/* ==========================================================================
   PHYGITAL BRASIL — CAMINHO ÚNICO DE E-MAIL

   O briefing é explícito: existe UMA configuração de SMTP e UM caminho de
   envio. Toda notificação do sistema (confirmação de inscrição, mudança de
   status, protocolo de chamado, código de verificação, disparo em massa)
   passa por enviar() daqui. Nenhum outro módulo deve falar de e-mail.

   Em desenvolvimento nada sai de verdade: o envio é gravado em
   emails_enviados com status='simulado' para poder ser inspecionado nos
   testes. O envio real só é cogitado quando o ambiente diz explicitamente que
   é produção E existe senha de SMTP configurada.

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
const db = require('./db');
const mapa = require('./mapa');
const { erro404 } = require('./http');

/* Base para montar a URL absoluta do logo: cliente de e-mail não resolve
   caminho relativo. */
const URL_BASE = process.env.PHYGITAL_URL || 'http://localhost:3000';

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

/**
 * Aplica um modelo de e-mail ao contexto.
 * @returns {{ id, para, ativo, assunto, corpo }} — corpo já em HTML seguro.
 */
function aplicarModelo(modeloId, contexto = {}) {
  const modelo = db.um('SELECT * FROM modelos_email WHERE id = ?', modeloId);
  if (!modelo) throw erro404(`Modelo de e-mail não encontrado: ${modeloId}.`);

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
   ENVIO
   -------------------------------------------------------------------------- */

/**
 * Só tenta SMTP de verdade quando o ambiente afirma produção E há senha.
 * Fora disso o envio é simulado — é o que permite rodar os testes sem mandar
 * e-mail para pessoas reais.
 */
function statusDeEnvio() {
  const producao = process.env.PHYGITAL_MODO === 'producao';
  const temSenha = Boolean(process.env.PHYGITAL_SMTP_SENHA);
  return producao && temSenha ? 'fila' : 'simulado';
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
 * @returns registro gravado (nunca lança)
 */
function enviar({
  modeloId = null, para = null, destino = null, contexto = {},
  assunto = null, corpo = null, qtd = null, anexos = [], rodape = ''
} = {}) {
  let assuntoFinal = assunto;
  let corpoFinal = corpo;
  let erro = null;

  /* modelo_id tem chave estrangeira para modelos_email: gravar um id que não
     existe derrubaria justamente o registro de falha que queremos guardar.
     Só vai para a coluna depois que o modelo é encontrado de verdade. */
  let modeloGravavel = null;

  try {
    if (modeloId) {
      const aplicado = aplicarModelo(modeloId, contexto);
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

  const enderecos = normalizarPara(para);
  const html = montarHtml({ assunto: assuntoFinal || '', corpo: corpoFinal || '', anexos, rodape });

  let status = erro ? 'falhou' : statusDeEnvio();

  if (!erro && !enderecos.length && !destino) {
    /* Sem destinatário e sem rótulo de público não há o que entregar. */
    erro = 'Envio sem destinatário.';
    status = 'falhou';
  }

  if (status === 'fila') {
    /* PONTO DE INTEGRAÇÃO SMTP REAL.
       O projeto não pode ganhar dependência npm e o Node não traz cliente
       SMTP, então aqui o e-mail fica gravado como 'fila': tudo pronto
       (destinatários, assunto, HTML final) esperando o conector. Quando ele
       existir, é ESTE bloco que dispara e atualiza a linha para 'entregue' ou
       'falhou' — nenhum outro lugar do sistema envia e-mail. */
  }

  const id = 'em-' + crypto.randomUUID();

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
    erro
  }, { id });

  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO emails_enviados (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );

  return {
    ok: status !== 'falhou',
    status,
    motivo: erro,
    id,
    modeloId,
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

/** O que está esperando o conector SMTP real. */
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
  VARIAVEIS_OBRIGATORIAS, RESSALVA_INSCRICAO
};
