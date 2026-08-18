/* ==========================================================================
   PHYGITAL BRASIL — DESPACHANTE DA FILA DE E-MAIL

   server/email.js grava e volta na hora: enviar() é SÍNCRONO e é chamado de
   dentro de transações de negócio (inscrever um time, abrir um chamado, mudar
   um status). Quem conversa com o servidor de e-mail é este módulo, e sempre
   FORA da transação.

   A separação é deliberada, não comodidade: uma sessão de SMTP leva segundos,
   pode travar e pode falhar. Se ela acontecesse dentro do db.transacao() que
   inscreve um time, um servidor de e-mail fora do ar desfaria a inscrição — e
   é a inscrição que importa, não o aviso.

   Divisão de responsabilidade:

     server/email.js    monta o conteúdo e grava a linha com status 'fila'
     server/smtp.js     fala o protocolo (TLS, EHLO, AUTH, MAIL/RCPT/DATA)
     este arquivo       decide QUANDO cada linha sai e o que fazer quando falha

   A senha vem de PHYGITAL_SMTP_SENHA, entra direto no config do cliente e não
   é gravada em lugar nenhum. Todo texto que vai para a coluna `erro` ou para a
   resposta de uma rota passa por semSegredo() antes — mesmo que o cliente já
   mascare a credencial no diálogo, a barreira é dupla de propósito.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const mapa = require('./mapa');
const email = require('./email');
const smtp = require('./smtp');

/* Quantas linhas uma rodada tira da fila. É teto, não meta. */
const LIMITE_PADRAO = 20;
const LIMITE_MAX = 200;

/* De quanto em quanto tempo o despachante acorda sozinho. O caminho normal é o
   setImmediate de agendar(), disparado pelo próprio enviar(); este intervalo é
   a rede de segurança para o que ficou adiado por falha temporária e para o que
   sobrou de uma execução anterior. */
const INTERVALO_PADRAO = 60000;

/* Recuo entre tentativas, em minutos.
   Cresce rápido de propósito: o que faz uma entrega falhar temporariamente —
   greylisting, caixa cheia, limite de ritmo do provedor — leva minutos para
   passar, e insistir de segundo em segundo só encosta a conta no limite de
   conexões do servidor, que é a maneira mais rápida de virar remetente
   bloqueado. Depois de MAX_TENTATIVAS a linha vira 'falhou' e para de consumir
   rodada: e-mail preso na fila para sempre é ruído que esconde falha nova. */
const RECUOS_MIN = [1, 5, 15, 60];
const MAX_TENTATIVAS = RECUOS_MIN.length + 1;   /* a última tentativa não é adiada */

/* Texto de erro é para diagnóstico, não para arquivo: o histórico do painel
   imprime esta coluna e uma resposta de servidor pode vir com um parágrafo. */
const ERRO_MAX = 400;

/* Escape para servidor interno com certificado próprio (e para o servidor SMTP
   falso dos testes). Fora disso o certificado é SEMPRE validado — desligar a
   validação entregaria a senha a quem atendesse a conexão no meio do caminho. */
const CERT_INVALIDO = /^(1|sim|true)$/i.test(
  String(process.env.PHYGITAL_SMTP_CERT_INVALIDO || '')
);

/* --------------------------------------------------------------------------
   APOIO
   -------------------------------------------------------------------------- */

/**
 * Tira a senha de qualquer texto antes de gravar ou responder.
 * Última barreira: nada que passe por aqui pode carregar a credencial para o
 * banco, para o log ou para a API.
 */
function semSegredo(texto) {
  let cru = String(texto === null || texto === undefined ? '' : texto);
  const senha = process.env.PHYGITAL_SMTP_SENHA;
  if (!senha) return cru;

  /* Mascarar só a forma literal deixava passar o caso que mais importa: um
     servidor mal-intencionado (o master pode apontar servidor_saida para
     qualquer host) responde ecoando o argumento do AUTH, e a senha em base64
     percorreria erro → coluna `erro` → GET /api/email/enviados → tela.
     Por isso também as formas codificadas.

     Sem piso de comprimento: senha curta é justamente a que mais precisa de
     proteção, e trocar 3 caracteres por asteriscos não quebra nada. */
  const formas = [
    senha,
    Buffer.from(senha, 'utf8').toString('base64'),
    encodeURIComponent(senha)
  ];

  for (const forma of formas) {
    if (forma && forma.length >= 3) cru = cru.split(forma).join('********');
  }

  /* AUTH PLAIN manda base64 de "\0usuario\0senha": o base64 da senha sozinha
     NÃO aparece como pedaço do todo, porque a codificação agrupa de 3 em 3
     bytes. Então qualquer token que pareça base64 é decodificado e, se contiver
     a senha, o token inteiro é mascarado. */
  return cru.replace(/[A-Za-z0-9+/]{12,}={0,2}/g, (token) => {
    try {
      const aberto = Buffer.from(token, 'base64').toString('utf8');
      return aberto.includes(senha) ? '********' : token;
    } catch (_) {
      return token;
    }
  });
}

const recortar = (texto, max = ERRO_MAX) => {
  const limpo = semSegredo(texto).replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
};

const emMinutos = (n) => new Date(Date.now() + n * 60000).toISOString();

/* --------------------------------------------------------------------------
   CONFIGURAÇÃO

   A tabela smtp guarda tudo menos a senha (não há coluna para ela, de
   propósito). Sem servidor de saída ou sem PHYGITAL_SMTP_SENHA não existe
   envio real, e é isso que mantém o desenvolvimento e a suíte de testes
   gravando 'simulado' em vez de falar com o provedor.
   -------------------------------------------------------------------------- */

/**
 * @returns {{ ok: true, config: object } | { ok: false, motivo: string }}
 *          `config` carrega a senha: nunca devolva este objeto por uma rota.
 */
function configuracaoSmtp() {
  const linha = db.um('SELECT * FROM smtp WHERE id = 1');
  const host = String((linha && linha.servidor_saida) || '').trim();

  if (!host) {
    return {
      ok: false,
      motivo: 'Servidor de saída não configurado em Disparo de E-mail → Configurações.'
    };
  }

  const usuario = String(linha.usuario || linha.email || '').trim();
  if (!usuario) {
    return { ok: false, motivo: 'Usuário do SMTP não configurado: sem ele não há como autenticar.' };
  }

  const senha = process.env.PHYGITAL_SMTP_SENHA || '';
  if (!senha) {
    return {
      ok: false,
      motivo: 'A senha do SMTP não está no ambiente: defina PHYGITAL_SMTP_SENHA e reinicie o servidor.'
    };
  }

  /* SEGUNDA TRAVA, DELIBERADA.
     A semente grava o servidor de PRODUÇÃO e endereços de pessoas reais. Se a
     senha sozinha bastasse para ligar o envio, qualquer desenvolvedor que
     exportasse a variável e testasse uma inscrição mandaria e-mail de verdade
     para essas pessoas, pelo servidor real, sem ter pedido isso em lugar nenhum.

     Ligar o envio precisa ser um ato explícito. Vale PHYGITAL_EMAIL_REAL=1 ou
     PHYGITAL_MODO=producao. */
  const liberado = process.env.PHYGITAL_EMAIL_REAL === '1'
    || process.env.PHYGITAL_MODO === 'producao';

  if (!liberado) {
    return {
      ok: false,
      motivo: 'A senha está configurada, mas o envio real não foi liberado. '
        + 'Defina PHYGITAL_EMAIL_REAL=1 (ou PHYGITAL_MODO=producao) para enviar de verdade.',
      travado: true
    };
  }

  const porta = Number(linha.smtp) || 587;
  const seguranca = String(linha.seguranca || '').trim().toUpperCase();

  /* 465 é TLS implícito (a conexão nasce cifrada); 587 e 25 abrem em claro e
     sobem por STARTTLS. A coluna `seguranca` só entra como desempate quando o
     provedor usa porta fora do padrão. */
  let seguro;
  if (porta === 465) seguro = true;
  else if (porta === 587 || porta === 25) seguro = false;
  else seguro = seguranca === 'SSL';

  return {
    ok: true,
    config: {
      host,
      porta,
      seguro,
      usuario,
      senha,
      /* Remetente do envelope: o provedor costuma exigir que seja a própria
         conta autenticada, ou recusa o envio como falsificação. */
      remetente: String(linha.email || usuario).trim(),
      nomeRemetente: String(linha.remetente || 'Esportes Phygital Brasil').trim(),
      permitirCertificadoInvalido: CERT_INVALIDO
    }
  };
}

/** Resumo da configuração sem nada sigiloso — é o que pode sair em log e API. */
function resumoConfiguracao() {
  const cfg = configuracaoSmtp();
  if (!cfg.ok) return { ok: false, motivo: cfg.motivo, envioReal: false };

  return {
    ok: true,
    envioReal: true,
    host: cfg.config.host,
    porta: cfg.config.porta,
    seguro: cfg.config.seguro,
    usuario: cfg.config.usuario,
    remetente: cfg.config.remetente
  };
}

/* --------------------------------------------------------------------------
   ESCRITA DO RESULTADO

   Cada saída possível de uma tentativa é uma função só, para o UPDATE da linha
   ficar num lugar único e previsível.
   -------------------------------------------------------------------------- */

function marcarEntregue(id, observacao) {
  db.executar(
    `UPDATE emails_enviados
        SET status = 'entregue', enviado_em = ?, tentativas = tentativas + 1, erro = ?
      WHERE id = ?`,
    /* Entrega limpa zera o erro. A observação só existe no caso parcial: a
       mensagem saiu, mas o servidor recusou um dos endereços da lista, e essa
       informação some se não for guardada aqui. */
    db.agora(), observacao ? recortar(observacao) : null, id
  );
}

function marcarFalha(id, motivo) {
  db.executar(
    `UPDATE emails_enviados
        SET status = 'falhou', erro = ?, tentativas = tentativas + 1, proxima_tentativa = NULL
      WHERE id = ?`,
    recortar(motivo), id
  );
}

/**
 * Falha temporária: a linha continua na fila com recuo maior.
 * @returns 'adiado' | 'falha' — vira falha definitiva ao esgotar as tentativas.
 */
function adiar(linha, motivo) {
  const tentativas = (Number(linha.tentativas) || 0) + 1;

  if (tentativas >= MAX_TENTATIVAS) {
    db.executar(
      `UPDATE emails_enviados
          SET status = 'falhou', erro = ?, tentativas = ?, proxima_tentativa = NULL
        WHERE id = ?`,
      recortar(`Desisti após ${tentativas} tentativas. Último erro: ${motivo}`),
      tentativas, linha.id
    );
    return 'falha';
  }

  db.executar(
    `UPDATE emails_enviados
        SET tentativas = ?, proxima_tentativa = ?, erro = ?
      WHERE id = ?`,
    tentativas, emMinutos(RECUOS_MIN[tentativas - 1]),
    recortar(`Tentativa ${tentativas} de ${MAX_TENTATIVAS}: ${motivo}`),
    linha.id
  );
  return 'adiado';
}

/* --------------------------------------------------------------------------
   ENTREGA DE UMA LINHA
   -------------------------------------------------------------------------- */

/**
 * Transmite uma linha da fila e grava o desfecho. NUNCA lança.
 * @returns {Promise<'entregue'|'adiado'|'falha'>}
 */
async function entregarLinha(linha, config) {
  const destinatarios = email.normalizarPara(linha.para);

  if (!destinatarios.length) {
    /* Linha de público ('Todos os campeonatos') sem endereço resolvido: não há
       o que tentar de novo, tentar amanhã dá no mesmo. */
    marcarFalha(linha.id, 'Sem destinatário gravado: não há para quem entregar.');
    return 'falha';
  }

  /* O envelope da marca é remontado aqui a partir do corpo guardado — a coluna
     `corpo` traz o fragmento, e montarHtml() é sempre a mesma função que a
     prévia do painel usa, então o que sai é o que o admin viu.
     Anexo não é reenviado: o histórico guarda só o metadado do arquivo (o teto
     de 2 MB da requisição impede guardar o conteúdo em base64 no banco). */
  const html = email.montarHtml({
    assunto: linha.assunto || '',
    corpo: linha.corpo || ''
  });

  /* UMA MENSAGEM POR DESTINATÁRIO.
     Mandar os endereços juntos colocaria todos no cabeçalho To:, e cada
     competidor receberia a lista de e-mail de todos os outros — vazamento de
     dado pessoal a terceiros, irreversível depois de entregue. O disparo em
     massa do briefing fala com centenas de responsáveis: é exatamente o caso
     onde isso doeria.

     Em série, não em paralelo: o provedor limita conexões simultâneas. */
  const pendentes = [];
  const recusadosPermanentes = [];
  let entregues = 0;
  let ultimoMotivo = null;
  let temporario = false;

  for (const endereco of destinatarios) {
    try {
      const r = await smtp.enviarMensagem(config, {
        de: { nome: config.nomeRemetente, endereco: config.remetente },
        para: [endereco],
        assunto: linha.assunto || '',
        html,
        /* Estável entre tentativas: sem isso, um 250 perdido no timeout faria o
           reenvio chegar como mensagem NOVA, e o competidor receberia a mesma
           confirmação cinco vezes sem o cliente conseguir agrupar. */
        idMensagem: idDaMensagem(linha.id, endereco, config)
      });

      if (r.ok) { entregues++; continue; }

      ultimoMotivo = `${endereco}: ${r.resposta}`;
      if (r.temporario) { pendentes.push(endereco); temporario = true; }
      else recusadosPermanentes.push(`${endereco} (${r.resposta})`);
    } catch (e) {
      ultimoMotivo = `${endereco}: ${(e && e.message) || 'falha desconhecida'}`;
      if (e && e.temporario) { pendentes.push(endereco); temporario = true; }
      else recusadosPermanentes.push(ultimoMotivo);
    }
  }

  if (!pendentes.length) {
    if (entregues) {
      marcarEntregue(
        linha.id,
        recusadosPermanentes.length
          ? `Entregue a ${entregues}. Recusados: ${recusadosPermanentes.join('; ')}.`
          : null
      );
      return 'entregue';
    }
    marcarFalha(linha.id, ultimoMotivo || 'Nenhum destinatário aceito.');
    return 'falha';
  }

  /* Retentativa só para quem ficou pendente: reescrever `para` impede reenviar
     a quem já recebeu. `qtd` continua o total original, que é o que o histórico
     do painel mostra. */
  db.executar('UPDATE emails_enviados SET para = ? WHERE id = ?', pendentes.join(', '), linha.id);

  return temporario
    ? adiar(linha, `${entregues} entregue(s), ${pendentes.length} pendente(s). ${ultimoMotivo || ''}`)
    : (marcarFalha(linha.id, ultimoMotivo || 'Falha no envio.'), 'falha');
}

/**
 * Message-ID determinístico: mesma linha e mesmo destinatário sempre geram o
 * mesmo identificador, então reenvio é reconhecido como repetição da mesma
 * mensagem em vez de uma nova.
 */
function idDaMensagem(linhaId, endereco, config) {
  const dominio = String(config.remetente || 'phygital').split('@')[1] || 'phygital';
  const marca = crypto.createHash('sha256')
    .update(`${linhaId}|${endereco.toLowerCase()}`)
    .digest('hex').slice(0, 24);
  return `<${marca}@${dominio}>`;
}

/* --------------------------------------------------------------------------
   RODADA
   -------------------------------------------------------------------------- */

async function rodada({ limite = LIMITE_PADRAO } = {}) {
  const resumo = { processados: 0, entregues: 0, falhas: 0, adiados: 0, motivo: null };

  const cfg = configuracaoSmtp();
  if (!cfg.ok) {
    /* Sem configuração utilizável a fila fica intacta: as linhas esperam a
       senha aparecer no ambiente em vez de virarem falha em massa. */
    resumo.motivo = cfg.motivo;
    return resumo;
  }

  const teto = Math.min(Math.max(Number(limite) || LIMITE_PADRAO, 1), LIMITE_MAX);

  let linhas;
  try {
    linhas = db.todos(
      `SELECT * FROM emails_enviados
        WHERE status = 'fila'
          AND (proxima_tentativa IS NULL OR proxima_tentativa <= ?)
        ORDER BY data, rowid
        LIMIT ?`,
      db.agora(), teto
    );
  } catch (e) {
    /* Banco fechando durante o encerramento do processo, por exemplo. */
    resumo.motivo = recortar((e && e.message) || 'Falha ao ler a fila.');
    return resumo;
  }

  for (const linha of linhas) {
    resumo.processados += 1;

    let desfecho;
    try {
      /* EM SÉRIE, de propósito: servidor de e-mail limita conexões simultâneas
         por conta, e um disparo em massa em paralelo abriria dezenas de uma vez
         — o provedor trata isso como abuso e bloqueia o remetente. Uma conexão
         por vez é mais lenta e é a única forma segura.
         eslint-disable-next-line no-await-in-loop */
      desfecho = await entregarLinha(linha, cfg.config);
    } catch (e) {
      /* entregarLinha não deveria lançar; se lançar (falha ao gravar, por
         exemplo), a rodada segue para a próxima linha em vez de morrer. */
      desfecho = 'falha';
      try { marcarFalha(linha.id, (e && e.message) || 'Falha inesperada no despacho.'); }
      catch (_) { /* banco indisponível: a linha continua na fila */ }
    }

    if (desfecho === 'entregue') resumo.entregues += 1;
    else if (desfecho === 'falha') resumo.falhas += 1;
    else resumo.adiados += 1;
  }

  return resumo;
}

/* Uma rodada por vez. Duas rodadas simultâneas — o setImmediate de um envio
   caindo em cima do intervalo do despachante — pegariam as MESMAS linhas 'fila'
   e entregariam a mesma mensagem duas vezes. A cadeia serializa: quem chama
   despachar() enquanto outra roda espera a vez e só então lê a fila. */
let corrente = Promise.resolve();

/**
 * Processa a fila. NUNCA lança: falha vira linha atualizada no banco.
 * @returns {Promise<{ processados, entregues, falhas, adiados, motivo }>}
 */
function despachar(opcoes = {}) {
  const proxima = corrente.then(() => rodada(opcoes), () => rodada(opcoes));
  /* A cadeia guarda a rodada com o erro já engolido: uma rejeição aqui não pode
     envenenar a próxima chamada. */
  corrente = proxima.then(() => {}, () => {});
  return proxima;
}

/**
 * Marca um despacho para o próximo tick. É o que server/email.js chama depois
 * de gravar a linha: o e-mail sai logo, sem prender a requisição e sem começar
 * uma sessão de SMTP dentro da transação que ainda não deu COMMIT.
 */
function agendar(opcoes = {}) {
  const marca = setImmediate(() => { despachar(opcoes).catch(() => {}); });
  /* unref para um despacho pendente não segurar o processo vivo — em script
     curto e na suíte de testes isso adiaria o encerramento. */
  if (marca.unref) marca.unref();
  return marca;
}

/* --------------------------------------------------------------------------
   CICLO DE VIDA
   -------------------------------------------------------------------------- */

let relogio = null;

/** Liga o despachante periódico. Idempotente: chamar duas vezes não duplica. */
function iniciarDespachante({ intervaloMs = INTERVALO_PADRAO } = {}) {
  pararDespachante();

  const intervalo = Math.max(Number(intervaloMs) || INTERVALO_PADRAO, 1000);
  relogio = setInterval(() => { despachar().catch(() => {}); }, intervalo);

  /* unref: o temporizador não pode segurar o processo no encerramento. */
  if (relogio.unref) relogio.unref();

  /* Uma rodada já na subida: o que ficou na fila de uma execução anterior
     (servidor derrubado no meio de um disparo) sai sem esperar o intervalo. */
  agendar();

  return relogio;
}

function pararDespachante() {
  if (!relogio) return false;
  clearInterval(relogio);
  relogio = null;
  return true;
}

const rodando = () => relogio !== null;

/* --------------------------------------------------------------------------
   INSPEÇÃO
   -------------------------------------------------------------------------- */

/** O que está pendente, com tentativas e próxima tentativa. Sem nada sigiloso. */
function pendentes(limite = 100) {
  const teto = Math.min(Math.max(Number(limite) || 100, 1), 500);

  return mapa.lista(
    db.todos(
      `SELECT * FROM emails_enviados
        WHERE status = 'fila'
        ORDER BY COALESCE(proxima_tentativa, data), rowid
        LIMIT ?`,
      teto
    ),
    mapa.emailEnviado
  );
}

module.exports = {
  despachar, agendar, iniciarDespachante, pararDespachante, rodando,
  configuracaoSmtp, resumoConfiguracao, pendentes, semSegredo,
  RECUOS_MIN, MAX_TENTATIVAS
};
