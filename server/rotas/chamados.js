/* ==========================================================================
   PHYGITAL BRASIL — CHAMADOS (CENTRAL DE ATENDIMENTO)

   O chamado é a válvula de escape da trava de edição: depois que as inscrições
   encerram, é por aqui que o competidor pede qualquer alteração no time. Por
   isso NENHUMA rota deste arquivo chama regras.exigirEdicaoLiberada() — seria
   circular, travaria justamente o canal criado para destravar.

   Endereçamento por PROTOCOLO, não por id: é o número que vai no e-mail, que o
   competidor tem em mãos e que as telas dos dois painéis exibem.

   Visibilidade:
     competidor → só os próprios chamados, sem os arquivados
     admin      → todos (chamados:ler); responder exige chamados:responder;
                  arquivar é exclusividade do master
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const auth = require('../auth');
const mapa = require('../mapa');
const regras = require('../regras');
const correio = require('../email');
const { erro400, erro403, erro404, erro409 } = require('../http');

/* Tetos de tamanho. O formulário do painel limita o assunto em 90 caracteres;
   aqui sobra folga para outros clientes, mas nada entra sem limite — texto sem
   teto é entrada livre para encher o banco. */
const LIMITE_ASSUNTO = 120;
const LIMITE_TEXTO = 4000;

/* A resposta da organização sai com assinatura institucional, como no protótipo.
   Quem de fato respondeu fica registrado na auditoria — o competidor não precisa
   saber o nome do atendente. */
const ASSINATURA_ORG = 'Organização Phygital';

const MODELOS = {
  aberto: 'chamado-aberto',
  novoParaAdmin: 'adm-novo-chamado',
  respondido: 'chamado-respondido',
  encerrado: 'chamado-encerrado'
};

/* --------------------------------------------------------------------------
   ENTRADA
   -------------------------------------------------------------------------- */

function exigirTexto(valor, campo, { min = 1, max = LIMITE_TEXTO } = {}) {
  const t = String(valor === undefined || valor === null ? '' : valor).trim();
  if (t.length < min) throw erro400(`Escreva ${campo} com pelo menos ${min} caracteres.`);
  if (t.length > max) throw erro400(`${campo} passa do limite de ${max} caracteres.`);
  return t;
}

/**
 * Traduz ?status= para uma condição SQL. Aceita os quatro status reais e os dois
 * apelidos que as telas usam ('abertos' = tudo que ainda está na fila).
 * O valor recebido nunca entra no SQL por interpolação.
 */
function condicaoDeStatus(bruto) {
  const v = String(bruto || '').trim();
  if (!v || v === 'todos') return { sql: '', params: [] };
  if (v === 'abertos') return { sql: " AND c.status <> 'encerrado'", params: [] };
  if (v === 'encerrados') return { sql: " AND c.status = 'encerrado'", params: [] };
  if (regras.STATUS_CHAMADO[v]) return { sql: ' AND c.status = ?', params: [v] };

  const validos = Object.keys(regras.STATUS_CHAMADO).join(', ');
  throw erro400(`Status desconhecido: ${v}. Use um destes: ${validos}, abertos, encerrados.`);
}

/* --------------------------------------------------------------------------
   CONSULTAS

   time_nome vem junto porque admin/chamados.html imprime o nome do time direto
   numa coluna (é o que mapa.chamadoAdmin espera receber).
   -------------------------------------------------------------------------- */

const SELECAO = `SELECT c.*, t.nome AS time_nome
                   FROM chamados c
                   LEFT JOIN times t ON t.id = c.time_id`;

function listar({ contaId = null, filtro } = {}) {
  const cond = condicaoDeStatus(filtro);
  const params = [];

  let sql = `${SELECAO} WHERE c.arquivado_em IS NULL`;
  if (contaId) {
    sql += ' AND c.conta_id = ?';
    params.push(contaId);
  }
  sql += cond.sql;
  sql += ' ORDER BY c.aberto_em DESC, c.id';

  return db.todos(sql, ...params, ...cond.params);
}

function buscar(protocolo) {
  const linha = db.um(`${SELECAO} WHERE c.protocolo = ?`, String(protocolo || '').trim());
  if (!linha) throw erro404('Chamado não encontrado.');
  return linha;
}

function mensagensDe(chamadoId) {
  return db.todos(
    'SELECT * FROM chamado_mensagens WHERE chamado_id = ? ORDER BY id', chamadoId
  );
}

/**
 * Resolve sessão + chamado para as rotas que servem aos dois painéis.
 *
 * Chamado de outra conta devolve o MESMO 404 de chamado inexistente: o
 * protocolo é sequencial e adivinhável, e um 403 confirmaria que ele existe.
 */
function acessar(ctx) {
  const conta = ctx.exigirLogin();
  const ehAdmin = conta.papel === 'admin';

  if (ehAdmin) ctx.exigirAdmin('chamados:ler');

  const chamado = buscar(ctx.params.protocolo);

  if (!ehAdmin && (chamado.conta_id !== conta.id || chamado.arquivado_em)) {
    throw erro404('Chamado não encontrado.');
  }

  return { conta, chamado, ehAdmin };
}

/** Recarrega o chamado com a conversa e devolve na forma do painel de quem pediu. */
function devolver(ctx, protocolo, ehAdmin, status = 200) {
  const linha = buscar(protocolo);
  const mensagens = mensagensDe(linha.id);
  const chamado = ehAdmin
    ? mapa.chamadoAdmin(linha, mensagens)
    : mapa.chamado(linha, mensagens);

  return status === 200
    ? ctx.ok({ ok: true, chamado })
    : ctx.json(status, { ok: true, chamado });
}

/* --------------------------------------------------------------------------
   ESCRITA
   -------------------------------------------------------------------------- */

function inserirMensagem(chamadoId, de, autor, texto) {
  const l = mapa.paraLinhaMensagem({ de, autor, texto }, { chamadoId });
  db.executar(
    `INSERT INTO chamado_mensagens (chamado_id, de, autor, texto, hora, criado_em)
     VALUES (?, ?, ?, ?, ?, ?)`,
    l.chamado_id, l.de, l.autor, l.texto, l.hora, l.criado_em
  );
}

function atualizarStatus(chamadoId, status) {
  db.executar(
    'UPDATE chamados SET status = ?, atualizado_em = ? WHERE id = ?',
    status, db.agora(), chamadoId
  );
}

/* --------------------------------------------------------------------------
   E-MAIL

   Nada é montado nem enviado aqui: tudo sai por email.enviar(), o caminho único
   do sistema. Este arquivo só decide QUANDO avisar e COM QUAIS valores.
   -------------------------------------------------------------------------- */

/** Monta o contexto de substituição documentado em mapa.VARIAVEIS_EMAIL. */
function contextoDo(chamado, conta) {
  const time = chamado.time_id
    ? db.um('SELECT * FROM times WHERE id = ?', chamado.time_id) : null;
  const campeonato = chamado.campeonato_id
    ? db.um('SELECT * FROM campeonatos WHERE id = ?', chamado.campeonato_id) : null;

  const status = regras.STATUS_CHAMADO[chamado.status];

  return {
    usuario: {
      nome: conta ? conta.nome : (chamado.autor || 'competidor'),
      email: conta ? conta.email : '',
      telefone: conta ? conta.telefone : ''
    },
    time: {
      /* Chamado sem time vinculado ainda identifica o solicitante pelo autor. */
      nome: (time && time.nome) || chamado.time_nome || chamado.autor || '—',
      modalidade: time ? regras.modalidade(time.modalidade).nome : '—',
      jogadores: time
        ? db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ?', time.id) : 0
    },
    campeonato: {
      nome: campeonato ? campeonato.nome : 'Assunto geral',
      data: campeonato ? campeonato.data : '',
      local: campeonato ? campeonato.local : '',
      encerramento: campeonato ? campeonato.encerramento_inscricoes : '',
      vagas: campeonato ? campeonato.vagas : ''
    },
    chamado: {
      protocolo: chamado.protocolo,
      assunto: chamado.assunto,
      /* O e-mail mostra o rótulo ("Em andamento"), não a chave do banco. */
      status: status ? status.rotulo : chamado.status
    }
    /* {{data}} e {{smtp.*}} são preenchidos pelo próprio email.enviar(). */
  };
}

const contaDo = (chamado) => (chamado.conta_id
  ? db.um('SELECT * FROM contas WHERE id = ?', chamado.conta_id) : null);

/**
 * Avisa quem abriu o chamado. Sai calado quando o chamado não tem conta
 * vinculada (os que a semente importou da fila antiga do admin) — sem endereço
 * não há aviso, e registrar uma falha nesse caso só sujaria o histórico.
 */
function avisarSolicitante(modeloId, chamado, conta) {
  const destinatario = conta || contaDo(chamado);
  if (!destinatario || !destinatario.email) return null;

  return correio.enviar({
    modeloId,
    para: destinatario.email,
    destino: `Chamado ${chamado.protocolo}`,
    contexto: contextoDo(chamado, destinatario)
  });
}

/** Quem trata chamado: master e operação. Gestor só lê, então não é avisado. */
function equipeDeAtendimento() {
  return db
    .todos(`SELECT * FROM contas
             WHERE papel = 'admin' AND arquivado_em IS NULL AND email IS NOT NULL
             ORDER BY email`)
    .filter((c) => auth.podeFazer(c, 'chamados:responder'));
}

/* --------------------------------------------------------------------------
   ROTAS
   -------------------------------------------------------------------------- */

/** GET /api/chamados — competidor vê os próprios; admin vê a fila inteira. */
async function listarChamados(ctx) {
  const conta = ctx.exigirLogin();
  const filtro = ctx.query.get('status');

  if (conta.papel === 'admin') {
    ctx.exigirAdmin('chamados:ler');
    const linhas = listar({ filtro });
    return ctx.ok({
      ok: true,
      chamados: linhas.map((l) => mapa.chamadoAdmin(l, mensagensDe(l.id)))
    });
  }

  const linhas = listar({ contaId: conta.id, filtro });
  return ctx.ok({
    ok: true,
    chamados: linhas.map((l) => mapa.chamado(l, mensagensDe(l.id)))
  });
}

/** GET /api/chamados/:protocolo */
async function verChamado(ctx) {
  const { chamado, ehAdmin } = acessar(ctx);
  return devolver(ctx, chamado.protocolo, ehAdmin);
}

/** POST /api/chamados — abertura pelo competidor. */
async function abrirChamado(ctx) {
  const conta = ctx.exigirCompetidor();
  const corpo = await ctx.corpo();

  const assunto = exigirTexto(corpo.assunto, 'um assunto', { min: 3, max: LIMITE_ASSUNTO });
  /* `mensagem` é o nome do campo no formulário do painel; `texto` é o do contrato
     da API. Aceitar os dois evita um adaptador só para renomear a chave. */
  const texto = exigirTexto(corpo.texto !== undefined ? corpo.texto : corpo.mensagem,
    'a mensagem', { min: 5, max: LIMITE_TEXTO });

  /* 'geral' é a opção "sem campeonato" que o front-end já usava. */
  const bruto = String(corpo.campeonatoId || corpo.campeonato || '').trim();
  const campeonatoId = (!bruto || bruto === 'geral') ? null : bruto;
  if (campeonatoId && !db.um('SELECT id FROM campeonatos WHERE id = ?', campeonatoId)) {
    throw erro400('Campeonato não encontrado.');
  }

  let timeId = String(corpo.timeId || corpo.time || '').trim() || null;
  if (timeId) {
    if (!db.um('SELECT id FROM times WHERE id = ? AND conta_id = ?', timeId, conta.id)) {
      throw erro403('Este time não pertence à sua conta.');
    }
  } else if (campeonatoId) {
    /* Sem time informado, deduz pela inscrição do próprio usuário naquele
       campeonato — é o que faz a fila do admin mostrar o nome do time. */
    timeId = db.valor(
      `SELECT i.time_id FROM inscricoes i
         JOIN times t ON t.id = i.time_id
        WHERE i.campeonato_id = ? AND t.conta_id = ? AND i.status <> 'cancelada'
        ORDER BY i.data DESC LIMIT 1`,
      campeonatoId, conta.id
    );
  }

  /* A categoria do formulário não tem coluna no esquema; fica na auditoria para
     não se perder. */
  const categoria = String(corpo.categoria || '').trim();

  const protocolo = db.transacao(() => {
    const numero = regras.proximoProtocolo('chamados');
    const id = crypto.randomUUID();

    const l = mapa.paraLinhaChamado(
      {
        protocolo: numero,
        campeonato: campeonatoId,
        timeId,
        assunto,
        status: 'aberto',
        autor: conta.nome
      },
      { id, contaId: conta.id }
    );

    db.executar(
      `INSERT INTO chamados (id, protocolo, conta_id, campeonato_id, time_id,
                             assunto, status, autor, aberto_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.id, l.protocolo, l.conta_id, l.campeonato_id, l.time_id,
      l.assunto, l.status, l.autor, l.aberto_em, l.atualizado_em
    );

    inserirMensagem(id, 'usuario', conta.nome, texto);
    inserirMensagem(id, 'sistema', null,
      `Chamado recebido — protocolo ${numero}. Status: ${regras.STATUS_CHAMADO.aberto.rotulo}.`);

    const chamado = buscar(numero);
    avisarSolicitante(MODELOS.aberto, chamado, conta);

    /* Um disparo só para a equipe inteira: o histórico não fica com uma linha
       por administrador. */
    const equipe = equipeDeAtendimento();
    if (equipe.length) {
      correio.enviar({
        modeloId: MODELOS.novoParaAdmin,
        para: equipe.map((a) => a.email),
        destino: 'Equipe de atendimento',
        contexto: contextoDo(chamado, conta)
      });
    }

    regras.registrar(ctx, 'chamados', numero, 'abrir',
      categoria ? `${assunto} (categoria: ${categoria})` : assunto);

    return numero;
  });

  return devolver(ctx, protocolo, false, 201);
}

/** POST /api/chamados/:protocolo/mensagens */
async function enviarMensagem(ctx) {
  const { conta, chamado, ehAdmin } = acessar(ctx);
  const corpo = await ctx.corpo();

  const texto = exigirTexto(corpo.texto !== undefined ? corpo.texto : corpo.mensagem,
    'a mensagem', { min: 1, max: LIMITE_TEXTO });

  if (chamado.status === 'encerrado') {
    throw erro409('Este chamado está encerrado. Abra um novo chamado para retomar o assunto.');
  }
  if (chamado.arquivado_em) {
    throw erro409('Este chamado foi arquivado e não aceita novas mensagens.');
  }

  let de = 'usuario';
  let autor = conta.nome;
  let novoStatus = chamado.status;

  if (ehAdmin) {
    ctx.exigirAdmin('chamados:responder');
    de = 'org';
    autor = ASSINATURA_ORG;
    novoStatus = 'respondido';
  } else if (chamado.status === 'respondido') {
    /* O competidor voltou a escrever: a bola é da organização de novo, senão o
       chamado ficaria marcado como respondido com pergunta em aberto. */
    novoStatus = 'andamento';
  }

  db.transacao(() => {
    inserirMensagem(chamado.id, de, autor, texto);
    if (novoStatus !== chamado.status) atualizarStatus(chamado.id, novoStatus);
    else db.executar('UPDATE chamados SET atualizado_em = ? WHERE id = ?', db.agora(), chamado.id);

    if (de === 'org') {
      avisarSolicitante(MODELOS.respondido, { ...chamado, status: novoStatus }, null);
    }

    regras.registrar(ctx, 'chamados', chamado.protocolo,
      de === 'org' ? 'responder' : 'mensagem', chamado.assunto);
  });

  return devolver(ctx, chamado.protocolo, ehAdmin, 201);
}

/** POST /api/chamados/:protocolo/status */
async function mudarStatus(ctx) {
  ctx.exigirAdmin('chamados:responder');
  const chamado = buscar(ctx.params.protocolo);
  const corpo = await ctx.corpo();

  const novo = String(corpo.status || '').trim();
  if (!regras.STATUS_CHAMADO[novo]) {
    throw erro400(`Status inválido: use um destes — ${Object.keys(regras.STATUS_CHAMADO).join(', ')}.`);
  }
  if (chamado.arquivado_em) {
    throw erro409('Este chamado foi arquivado. Restaure-o antes de mudar o status.');
  }

  /* Repetir o status atual não é erro, mas também não pode gerar mensagem nem
     e-mail duplicado. */
  if (novo === chamado.status) return devolver(ctx, chamado.protocolo, true);

  const anterior = chamado.status;

  db.transacao(() => {
    atualizarStatus(chamado.id, novo);

    if (novo === 'encerrado') {
      inserirMensagem(chamado.id, 'sistema', null, 'Chamado encerrado pela organização.');
    } else if (anterior === 'encerrado') {
      /* Sem esta linha a conversa terminaria dizendo "encerrado" com o chamado
         de volta à fila. */
      inserirMensagem(chamado.id, 'sistema', null, 'Chamado reaberto pela organização.');
    }

    /* O modelo "chamado-respondido" cobre qualquer atualização ("Status: X"),
       que é exatamente o que uma mudança manual de status é. */
    avisarSolicitante(
      novo === 'encerrado' ? MODELOS.encerrado : MODELOS.respondido,
      { ...chamado, status: novo }, null
    );

    regras.registrar(ctx, 'chamados', chamado.protocolo, 'status',
      `${regras.STATUS_CHAMADO[anterior].rotulo} → ${regras.STATUS_CHAMADO[novo].rotulo}`);
  });

  return devolver(ctx, chamado.protocolo, true);
}

/**
 * DELETE /api/chamados/:protocolo — arquivamento lógico.
 *
 * A permissão 'chamados:arquivar' não aparece em nenhum nível: só o master, que
 * tem '*', passa. A conversa continua no banco — o chamado só sai das listas.
 */
async function arquivarChamado(ctx) {
  ctx.exigirAdmin('chamados:arquivar');
  const chamado = buscar(ctx.params.protocolo);

  if (chamado.arquivado_em) throw erro409('Este chamado já está arquivado.');

  const em = db.agora();
  db.transacao(() => {
    db.executar(
      'UPDATE chamados SET arquivado_em = ?, atualizado_em = ? WHERE id = ?',
      em, em, chamado.id
    );
    regras.registrar(ctx, 'chamados', chamado.protocolo, 'arquivar', chamado.assunto);
  });

  return ctx.ok({ ok: true, protocolo: chamado.protocolo, arquivadoEm: em });
}

/* -------------------------------------------------------------------------- */

function registrar(rotas) {
  rotas.get('/api/chamados', listarChamados);
  rotas.get('/api/chamados/:protocolo', verChamado);
  rotas.post('/api/chamados', abrirChamado);
  rotas.post('/api/chamados/:protocolo/mensagens', enviarMensagem);
  rotas.post('/api/chamados/:protocolo/status', mudarStatus);
  rotas.delete('/api/chamados/:protocolo', arquivarChamado);
}

module.exports = { registrar };
