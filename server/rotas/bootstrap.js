/* ==========================================================================
   PHYGITAL BRASIL — DESCOBERTA E CARGA INICIAL

   As páginas do site leem PB.dados.* de forma SÍNCRONA e não podem ser
   alteradas. Por isso o front-end faz UMA chamada a /api/bootstrap, guarda a
   resposta num cache em memória e segue lendo desse cache sem esperar nada.

   Consequência: a resposta precisa ter exatamente a mesma forma que a antiga
   semente() do front-end tinha. A tradução fica em ../mapa.js — aqui só
   decidimos O QUE cada tipo de sessão pode ver.

   Visibilidade, em ordem crescente:
     sem sessão  → apenas conteúdo público (o resto vem vazio)
     competidor  → + a própria conta, os próprios times, inscrições e chamados
     admin       → + fila de chamados, usuários, e-mails, auditoria e SMTP
   ========================================================================== */
'use strict';

const db = require('../db');
const auth = require('../auth');
const regras = require('../regras');
const mapa = require('../mapa');

const VERSAO = '2.0.0';

/* O front-end indexa ranking[modalidade] sem checar a chave; a lista garante
   que toda modalidade exista no payload, nem que seja vazia. */
const MODALIDADES = Object.keys(regras.MODALIDADES);

/* Teto do que volta em listas de histórico. Sem isso o bootstrap cresce sem
   limite e passa a pesar em toda abertura de página. */
const LIMITE_AUDITORIA = 500;
const LIMITE_EMAILS = 200;

/* --------------------------------------------------------------------------
   APOIO
   -------------------------------------------------------------------------- */

/** Lista de '?' para um IN — só marcadores, nenhum dado entra no SQL. */
const marcadores = (ids) => ids.map(() => '?').join(', ');

function agrupar(linhas, chave) {
  const indice = {};
  linhas.forEach((l) => {
    const k = l[chave];
    if (!indice[k]) indice[k] = [];
    indice[k].push(l);
  });
  return indice;
}

/**
 * O campeonato não guarda contador: inscritos/oficial/espera saem da tabela de
 * inscrições. `inscritos` é o total que não foi cancelado — inclui quem já está
 * na lista oficial e na de espera, como na tela do administrador.
 */
function contagensDeInscricao() {
  const linhas = db.todos(
    `SELECT campeonato_id,
            SUM(CASE WHEN status <> 'cancelada' THEN 1 ELSE 0 END) AS inscritos,
            SUM(CASE WHEN status =  'oficial'   THEN 1 ELSE 0 END) AS oficial,
            SUM(CASE WHEN status =  'espera'    THEN 1 ELSE 0 END) AS espera
       FROM inscricoes
      GROUP BY campeonato_id`
  );

  const indice = {};
  linhas.forEach((l) => { indice[l.campeonato_id] = l; });
  return indice;
}

/**
 * Monta os times completos (jogadores com documentos + comissão) em três
 * consultas, independentemente da quantidade de times — o front-end espera o
 * elenco aninhado dentro de cada time.
 *
 * Jogadores saem com reservas no fim e, dentro de cada grupo, na ordem de
 * cadastro: o índice do array é o que as telas usam para gravar documento.
 */
function montarTimes(linhasTimes) {
  if (!linhasTimes.length) return [];

  const ids = linhasTimes.map((t) => t.id);
  const marca = marcadores(ids);

  const jogadores = db.todos(
    `SELECT * FROM jogadores WHERE time_id IN (${marca}) ORDER BY reserva, ordem, id`, ...ids
  );
  const equipe = db.todos(
    `SELECT * FROM staff WHERE time_id IN (${marca}) ORDER BY ordem, id`, ...ids
  );
  /* Busca os documentos pelo time, não pelo jogador: o número de parâmetros
     fica preso à quantidade de times, que é sempre menor. */
  const documentos = db.todos(
    `SELECT d.* FROM documentos d
       JOIN jogadores j ON j.id = d.jogador_id
      WHERE j.time_id IN (${marca})
      ORDER BY d.tipo`, ...ids
  );

  const jogadoresPorTime = agrupar(jogadores, 'time_id');
  const staffPorTime = agrupar(equipe, 'time_id');
  const docsPorJogador = agrupar(documentos, 'jogador_id');

  return linhasTimes.map((t) => mapa.time(
    t, jogadoresPorTime[t.id] || [], staffPorTime[t.id] || [], docsPorJogador
  ));
}

function mensagensPorChamado(ids) {
  if (!ids.length) return {};
  const linhas = db.todos(
    `SELECT * FROM chamado_mensagens
      WHERE chamado_id IN (${marcadores(ids)})
      ORDER BY chamado_id, id`, ...ids
  );
  return agrupar(linhas, 'chamado_id');
}

/* --------------------------------------------------------------------------
   BLOCOS DO PAYLOAD
   -------------------------------------------------------------------------- */

/**
 * Toda chave que a semente antiga tinha, vazia. Serve de piso: uma página
 * pública nunca recebe `undefined` no lugar de uma lista, e nenhum dado de
 * outra conta entra por esquecimento — só o que os blocos abaixo preenchem.
 */
function vazio() {
  return {
    campeonatos: [],
    resultados: [],
    ranking: {},
    posts: [],
    eventos: [],
    parceiros: [],
    usuario: null,
    meusTimes: [],
    minhasInscricoes: [],
    chamados: [],
    adminChamados: [],
    adminUsuarios: [],
    banners: [],
    bannersSite: [],
    emailsEnviados: [],
    auditoria: [],
    smtp: {},
    categorias: [],
    rankingConfig: {},
    modelosEmail: [],
    variaveisEmail: []
  };
}

/** O que qualquer visitante vê — nada aqui depende de sessão. */
function publico() {
  const contagens = contagensDeInscricao();

  /* Encerrados no fim da lista e, dentro de cada grupo, o evento mais próximo
     primeiro — é a ordem que a home e a página de inscrições esperam. */
  const campeonatos = db.todos(
    `SELECT * FROM campeonatos
      WHERE arquivado_em IS NULL
      ORDER BY (status = 'encerrado'), data, id`
  ).map((l) => mapa.campeonato(l, contagens[l.id]));

  const ranking = db.todos(
    `SELECT * FROM ranking
      ORDER BY modalidade, COALESCE(posicao, 9999), v DESC, nome`
  );

  return {
    campeonatos,
    resultados: mapa.lista(
      db.todos('SELECT * FROM resultados ORDER BY data DESC, id DESC'), mapa.resultado
    ),
    ranking: mapa.rankingPorModalidade(ranking, MODALIDADES),
    /* Rascunho é do administrador: o site público só recebe o que foi publicado. */
    posts: mapa.lista(
      db.todos(`SELECT * FROM posts
                 WHERE arquivado_em IS NULL AND publicado = 1
                 ORDER BY data DESC, id`), mapa.post
    ),
    eventos: mapa.lista(
      db.todos('SELECT * FROM eventos WHERE arquivado_em IS NULL ORDER BY ano DESC, id'), mapa.evento
    ),
    /* A ordem é o que amarra cada parceiro ao seu logo na home. */
    parceiros: mapa.lista(
      db.todos('SELECT * FROM parceiros WHERE arquivado_em IS NULL ORDER BY ordem, id'), mapa.parceiro
    ),
    bannersSite: mapa.lista(
      db.todos('SELECT * FROM banners_site WHERE arquivado_em IS NULL ORDER BY ordem, id'), mapa.bannerSite
    ),
    categorias: mapa.lista(
      db.todos('SELECT * FROM categorias WHERE arquivado_em IS NULL ORDER BY nome'), mapa.categoria
    )
  };
}

/** Acréscimo da sessão de competidor: só o que pertence à própria conta. */
function doCompetidor(conta) {
  const times = db.todos(
    'SELECT * FROM times WHERE conta_id = ? AND arquivado_em IS NULL ORDER BY criado_em, id',
    conta.id
  );

  /* Inscrição cancelada vem junto de propósito: o front-end a trata como item
     de histórico (mapa.inscricao marca `arquivado`) e filtra sozinho. */
  const inscricoes = db.todos(
    `SELECT i.* FROM inscricoes i
       JOIN times t ON t.id = i.time_id
      WHERE t.conta_id = ?
      ORDER BY i.data DESC, i.id`,
    conta.id
  );

  const chamados = db.todos(
    'SELECT * FROM chamados WHERE conta_id = ? AND arquivado_em IS NULL ORDER BY aberto_em DESC, id',
    conta.id
  );
  const mensagens = mensagensPorChamado(chamados.map((c) => c.id));

  return {
    meusTimes: montarTimes(times),
    minhasInscricoes: mapa.lista(inscricoes, mapa.inscricao),
    chamados: chamados.map((c) => mapa.chamado(c, mensagens[c.id])),
    banners: mapa.lista(
      db.todos('SELECT * FROM banners WHERE arquivado_em IS NULL ORDER BY ordem, id'), mapa.banner
    )
  };
}

/** Acréscimo da sessão de administrador. */
function doAdmin(conta) {
  /* time_nome porque admin/chamados.html imprime o nome do time numa coluna. */
  const chamados = db.todos(
    `SELECT c.*, t.nome AS time_nome
       FROM chamados c
       LEFT JOIN times t ON t.id = c.time_id
      WHERE c.arquivado_em IS NULL
      ORDER BY c.aberto_em DESC, c.id`
  );
  const mensagens = mensagensPorChamado(chamados.map((c) => c.id));

  const times = db.todos('SELECT * FROM times WHERE arquivado_em IS NULL ORDER BY criado_em, id');
  const inscricoes = db.todos('SELECT * FROM inscricoes ORDER BY data DESC, id');

  /* papel não existe em auditoria: vem da conta que assinou o registro. */
  const auditoria = db.todos(
    `SELECT a.*, c.papel AS papel
       FROM auditoria a
       LEFT JOIN contas c ON c.id = a.conta_id
      ORDER BY a.em DESC
      LIMIT ?`,
    LIMITE_AUDITORIA
  );

  /* A tela Minha Conta do admin lê adminUsuarios()[0] como sendo o próprio
     usuário logado — daí ele vir primeiro. */
  const usuarios = db.todos(
    `SELECT * FROM contas
      WHERE papel = 'admin' AND arquivado_em IS NULL
      ORDER BY (id = ?) DESC, criado_em, id`,
    conta.id
  );

  return {
    /* Sem filtro de publicado: o CMS precisa enxergar os rascunhos. */
    posts: mapa.lista(
      db.todos('SELECT * FROM posts WHERE arquivado_em IS NULL ORDER BY data DESC, id'), mapa.post
    ),
    meusTimes: montarTimes(times),
    minhasInscricoes: mapa.lista(inscricoes, mapa.inscricao),
    adminChamados: chamados.map((c) => mapa.chamadoAdmin(c, mensagens[c.id])),
    adminUsuarios: mapa.lista(usuarios, mapa.adminUsuario),
    banners: mapa.lista(
      db.todos('SELECT * FROM banners WHERE arquivado_em IS NULL ORDER BY ordem, id'), mapa.banner
    ),
    /* Inclui arquivados: a tela de banners do site tem a própria aba de
       histórico e usa o campo `arquivado` para separar. */
    bannersSite: mapa.lista(
      db.todos('SELECT * FROM banners_site ORDER BY ordem, id'), mapa.bannerSite
    ),
    emailsEnviados: mapa.lista(
      db.todos('SELECT * FROM emails_enviados ORDER BY data DESC, id LIMIT ?', LIMITE_EMAILS),
      mapa.emailEnviado
    ),
    auditoria: mapa.lista(auditoria, mapa.auditoria),
    smtp: mapa.smtp(db.um('SELECT * FROM smtp WHERE id = 1')),
    /* A tela agrupa na ordem em que os modelos chegam; alertas internos vão
       para o fim porque interessam menos que os que falam com o competidor. */
    modelosEmail: mapa.lista(
      db.todos("SELECT * FROM modelos_email ORDER BY (para = 'admin'), grupo, nome"),
      mapa.modeloEmail
    ),
    variaveisEmail: mapa.VARIAVEIS_EMAIL,
    rankingConfig: mapa.rankingConfigPorModalidade(
      db.todos('SELECT * FROM ranking_config'), MODALIDADES
    )
  };
}

/* --------------------------------------------------------------------------
   MONTAGEM
   -------------------------------------------------------------------------- */

function montar(ctx) {
  const conta = ctx.conta;
  const dados = Object.assign(vazio(), publico());

  /* A própria conta vale para os dois painéis: admin/campeonato-time.html
     também lê D.usuario() para identificar quem está operando. */
  if (conta) dados.usuario = mapa.usuario(conta);
  if (conta && conta.papel === 'competidor') Object.assign(dados, doCompetidor(conta));
  if (conta && conta.papel === 'admin') Object.assign(dados, doAdmin(conta));

  return {
    ok: true,
    modo: 'api',
    /* As regras de elenco vêm do servidor para o front-end não validar com uma
       cópia divergente da sua. */
    modalidades: regras.MODALIDADES,
    conta: auth.contaPublica(conta),
    dados
  };
}

function registrar(rotas) {
  /* É como o front-end descobre se existe back-end: precisa ser barata e nunca
     tocar em sessão, senão a página estática trava esperando resposta. */
  rotas.get('/api/ping', (ctx) => ctx.ok({ ok: true, modo: 'api', versao: VERSAO }));

  rotas.get('/api/bootstrap', (ctx) => ctx.ok(montar(ctx)));
}

module.exports = { registrar, montar, VERSAO };
