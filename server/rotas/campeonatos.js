/* ==========================================================================
   PHYGITAL BRASIL — CAMPEONATOS

   Leitura pública (site, home, página de inscrições) e todo o ciclo de vida no
   painel do administrador: criar, publicar, encerrar inscrições, iniciar,
   encerrar, apurar, duplicar e arquivar.

   Duas regras do briefing moram aqui e em nenhum outro lugar:

   · os limites de elenco são copiados da modalidade no momento da criação, para
     que uma edição antiga continue valendo pela regra com que foi publicada;
   · a APURAÇÃO é a única porta de entrada do ranking global — nenhuma outra
     rota escreve na tabela ranking.

   As contagens de inscritos/oficial/espera nunca são lidas de um contador
   gravado: saem sempre de uma agregação sobre `inscricoes`, que é a única fonte
   confiável depois de cancelamentos e mudanças de lista.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const mapa = require('../mapa');
const regras = require('../regras');
const { erro400, erro404, erro409 } = require('../http');

/* Teto sanitário da classificação: protege a transação de um corpo absurdo. */
const MAX_COLOCACOES = 512;

/* Ação registrada na auditoria para cada destino do ciclo de vida. */
const ACAO_DO_STATUS = {
  rascunho: 'voltou para rascunho',
  inscricoes: 'publicou',
  fechado: 'encerrou as inscrições',
  andamento: 'iniciou',
  encerrado: 'encerrou'
};

/* --------------------------------------------------------------------------
   CONSULTAS DE APOIO
   -------------------------------------------------------------------------- */

const SOMA_INSCRICOES = `
  SUM(CASE WHEN status <> 'cancelada' THEN 1 ELSE 0 END) AS inscritos,
  SUM(CASE WHEN status =  'oficial'   THEN 1 ELSE 0 END) AS oficial,
  SUM(CASE WHEN status =  'espera'    THEN 1 ELSE 0 END) AS espera`;

/** Contagens de um campeonato. `inscritos` é tudo que não foi cancelado. */
function contagens(campeonatoId) {
  return db.um(
    `SELECT ${SOMA_INSCRICOES} FROM inscricoes WHERE campeonato_id = ?`, campeonatoId
  ) || {};
}

/** Mesma agregação para uma listagem inteira, em uma consulta só. */
function contagensDeTodos() {
  const indice = {};
  db.todos(`SELECT campeonato_id, ${SOMA_INSCRICOES} FROM inscricoes GROUP BY campeonato_id`)
    .forEach((l) => { indice[l.campeonato_id] = l; });
  return indice;
}

function buscar(id, { comArquivado = false } = {}) {
  const linha = db.um('SELECT * FROM campeonatos WHERE id = ?', id);
  if (!linha || (linha.arquivado_em && !comArquivado)) {
    throw erro404('Campeonato não encontrado.');
  }
  return linha;
}

const paraFront = (linha, cont) => mapa.campeonato(linha, cont || contagens(linha.id));

const ehAdmin = (ctx) => Boolean(ctx.conta && ctx.conta.papel === 'admin');

/** Lista de '?' para um IN — só marcadores, nenhum dado entra no SQL. */
const marcadores = (ids) => ids.map(() => '?').join(', ');

function agrupar(linhas, chave) {
  const indice = {};
  linhas.forEach((l) => {
    if (!indice[l[chave]]) indice[l[chave]] = [];
    indice[l[chave]].push(l);
  });
  return indice;
}

/**
 * Times completos (elenco, comissão e documentos aninhados) em três consultas,
 * independentemente da quantidade de times. A ordem dos jogadores é reservas no
 * fim e, dentro de cada grupo, a de cadastro — é ela que o export usa para
 * nomear as fotos.
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
  const documentos = db.todos(
    `SELECT d.* FROM documentos d
       JOIN jogadores j ON j.id = d.jogador_id
      WHERE j.time_id IN (${marca})
      ORDER BY d.tipo`, ...ids
  );

  const porTime = agrupar(jogadores, 'time_id');
  const staffPorTime = agrupar(equipe, 'time_id');
  const docsPorJogador = agrupar(documentos, 'jogador_id');

  return linhasTimes.map((t) => mapa.time(
    t, porTime[t.id] || [], staffPorTime[t.id] || [], docsPorJogador
  ));
}

/* --------------------------------------------------------------------------
   GRAVAÇÃO

   As colunas saem sempre de mapa.paraLinhaCampeonato — nunca do corpo da
   requisição — e os valores viajam como parâmetro.
   -------------------------------------------------------------------------- */

function inserirLinha(linha) {
  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO campeonatos (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );
}

function atualizarLinha(id, linha) {
  /* id e criado_em não se alteram numa edição. */
  const colunas = Object.keys(linha).filter((c) => c !== 'id' && c !== 'criado_em');
  db.executar(
    `UPDATE campeonatos SET ${colunas.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
    ...colunas.map((c) => linha[c]), id
  );
}

/* --------------------------------------------------------------------------
   IDENTIFICADOR

   O id viaja na URL das telas (campeonato-gerenciar.html?id=cbf-2026), então
   vale a pena ser legível em vez de um UUID.
   -------------------------------------------------------------------------- */

const ID_ACEITO = /^[a-z0-9][a-z0-9-]{2,39}$/;

function apelidar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   /* acento não vai para a URL */
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function idLivre(base) {
  const raiz = base && base.length >= 3 ? base : `camp-${Date.now().toString(36)}`;
  let id = raiz;
  let n = 2;
  while (db.um('SELECT 1 FROM campeonatos WHERE id = ?', id)) {
    id = `${raiz}-${n}`;
    n++;
  }
  return id;
}

function idEscolhido(corpo, nome) {
  if (!corpo.id) return idLivre(apelidar(nome));

  const id = String(corpo.id).trim().toLowerCase();
  if (!ID_ACEITO.test(id)) {
    throw erro400('O identificador aceita apenas letras minúsculas, números e hífen (3 a 40 caracteres).');
  }
  if (db.um('SELECT 1 FROM campeonatos WHERE id = ?', id)) {
    throw erro409(`Já existe um campeonato com o identificador "${id}".`);
  }
  return id;
}

/* --------------------------------------------------------------------------
   VALIDAÇÃO DO CAMPEONATO
   -------------------------------------------------------------------------- */

function exigirModalidade(id) {
  const chave = String(id || '').trim();
  /* regras.modalidade() cai em 'outros' quando não conhece a chave; no cadastro
     isso esconderia um erro de digitação, então aqui a chave tem que existir. */
  if (!regras.MODALIDADES[chave]) {
    throw erro400(`Modalidade desconhecida: "${chave}". Use uma destas: ${Object.keys(regras.MODALIDADES).join(', ')}.`);
  }
  return chave;
}

const numero = (v, padrao) => (v === undefined || v === null || v === '' ? padrao : Number(v));

/**
 * Limites de elenco do campeonato. A modalidade é o TETO: o administrador pode
 * apertar a regra para uma edição específica, nunca afrouxá-la — as faixas do
 * briefing (futebol 6-8, shooter exatos 5, dança 1…) valem para toda a
 * plataforma.
 */
function limitesDoCampeonato(modalidadeId, corpo) {
  const m = regras.MODALIDADES[modalidadeId];
  const erros = [];

  const jogadoresMin = numero(corpo.jogadoresMin, m.jogadoresMin);
  const jogadoresMax = numero(corpo.jogadoresMax, m.jogadoresMax);
  const staffMax = numero(corpo.staffMax, m.staffMax);
  /* O front-end manda `reservas` como sim/não e `reservasMax` como teto. */
  const reservasMax = corpo.reservas === false ? 0 : numero(corpo.reservasMax, m.reservasMax);

  const inteiro = (v, rotulo) => {
    if (!Number.isInteger(v) || v < 0) erros.push(`${rotulo} precisa ser um número inteiro.`);
  };
  inteiro(jogadoresMin, 'O mínimo de jogadores');
  inteiro(jogadoresMax, 'O máximo de jogadores');
  inteiro(reservasMax, 'O máximo de reservas');
  inteiro(staffMax, 'O limite de comissão');

  if (!erros.length) {
    if (jogadoresMin < m.jogadoresMin) {
      erros.push(`${m.nome} exige no mínimo ${m.jogadoresMin} jogador(es).`);
    }
    if (jogadoresMax > m.jogadoresMax) {
      erros.push(`${m.nome} aceita no máximo ${m.jogadoresMax} jogador(es).`);
    }
    if (jogadoresMin > jogadoresMax) {
      erros.push('O mínimo de jogadores não pode ser maior que o máximo.');
    }
    if (reservasMax > m.reservasMax) {
      erros.push(`${m.nome} aceita no máximo ${m.reservasMax} reserva(s).`);
    }
    if (staffMax > m.staffMax) {
      erros.push(`${m.nome} aceita no máximo ${m.staffMax} na comissão (${m.staffRotulo}).`);
    }
  }

  if (erros.length) throw erro400(erros.join(' '), { erros });

  return { jogadoresMin, jogadoresMax, staffMax, reservasMax, reservas: reservasMax > 0 };
}

/* Datas em ISO ordenam como texto, então a comparação direta basta. */
function exigirDatasCoerentes(c) {
  const erros = [];

  if (c.aberturaInscricoes && c.encerramentoInscricoes
      && c.aberturaInscricoes > c.encerramentoInscricoes) {
    erros.push('A abertura das inscrições não pode ser depois do encerramento.');
  }
  if (c.data && c.dataFim && c.dataFim < c.data) {
    erros.push('O fim do campeonato não pode ser antes do começo.');
  }
  if (c.encerramentoInscricoes && c.data && c.encerramentoInscricoes > c.data) {
    erros.push('As inscrições precisam encerrar até a data de realização.');
  }

  if (erros.length) throw erro400(erros.join(' '), { erros });
}

/**
 * Sem data de encerramento das inscrições a trava de edição do competidor fica
 * sem referência, e sem data de realização o site não tem o que anunciar — por
 * isso publicar exige esses campos.
 */
function exigirDadosParaPublicar(linha) {
  const faltando = [];
  if (!linha.abertura_inscricoes) faltando.push('abertura das inscrições');
  if (!linha.encerramento_inscricoes) faltando.push('encerramento das inscrições');
  if (!linha.data) faltando.push('data de realização');
  if (!Number(linha.vagas)) faltando.push('número de vagas');

  if (faltando.length) {
    throw erro409(`Para publicar o campeonato, preencha antes: ${faltando.join(', ')}.`, { faltando });
  }
}

/* --------------------------------------------------------------------------
   E-MAIL

   Não existe cliente SMTP no projeto (nenhuma dependência externa), então o
   disparo é sempre gravado como 'simulado': serve de histórico na tela do
   administrador e de ponto de conferência nos testes. Uma linha POR
   DESTINATÁRIO, para dar para verificar quem recebeu o quê.
   -------------------------------------------------------------------------- */

function valorDaVariavel(vars, caminho) {
  return caminho.split('.').reduce((obj, parte) => (obj == null ? null : obj[parte]), vars);
}

/** Substitui {{caminho.da.variavel}}; o que não existe vira string vazia. */
function preencher(texto, vars) {
  return String(texto || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, chave) => {
    const v = valorDaVariavel(vars, chave);
    return v === null || v === undefined ? '' : String(v);
  });
}

function variaveisDoCampeonato(linha) {
  const cont = contagens(linha.id);
  const smtp = db.um('SELECT servidor_saida FROM smtp WHERE id = 1');

  return {
    campeonato: {
      nome: linha.nome,
      data: mapa.soData(linha.data) || '',
      local: linha.local || '',
      encerramento: mapa.soData(linha.encerramento_inscricoes) || '',
      vagas: linha.vagas || 0,
      inscritos: cont.inscritos || 0,
      oficial: cont.oficial || 0,
      espera: cont.espera || 0
    },
    data: mapa.dataHora(db.agora()),
    smtp: { servidor: smtp ? smtp.servidor_saida : '' }
  };
}

/**
 * @param destinatarios  contas ({ nome, email, telefone })
 * @param destino        rótulo do disparo na tela de histórico
 * @returns quantos registros foram gravados
 */
function disparar(modeloId, destinatarios, variaveis, destino) {
  /* Modelo desligado pelo administrador não dispara — é o interruptor da tela
     de modelos de e-mail. */
  const modelo = db.um('SELECT * FROM modelos_email WHERE id = ? AND ativo = 1', modeloId);
  if (!modelo) return 0;

  const lista = (destinatarios || []).filter((d) => d && d.email);

  lista.forEach((d) => {
    const vars = {
      ...variaveis,
      usuario: { nome: d.nome, email: d.email, telefone: d.telefone || '' }
    };
    const linha = mapa.paraLinhaEmailEnviado({
      id: crypto.randomUUID(),
      modeloId: modelo.id,
      assunto: preencher(modelo.assunto, vars),
      destino,
      para: d.email,
      corpo: preencher(modelo.corpo, vars),
      qtd: 1
    });

    db.executar(
      `INSERT INTO emails_enviados
         (id, modelo_id, assunto, destino, para, corpo, qtd, status, erro, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      linha.id, linha.modelo_id, linha.assunto, linha.destino, linha.para,
      linha.corpo, linha.qtd, linha.status, linha.erro, linha.data
    );
  });

  return lista.length;
}

/** Avisa administradores e responsáveis quando as inscrições são encerradas. */
function avisarEncerramentoDasInscricoes(linha) {
  const vars = variaveisDoCampeonato(linha);

  const admins = db.todos(
    `SELECT nome, email, telefone FROM contas
      WHERE papel = 'admin' AND arquivado_em IS NULL`
  );

  /* Só o responsável pelo time recebe (no dance, a própria atleta é a conta).
     DISTINCT porque a mesma conta pode ter mais de um time no campeonato e não
     deve receber o aviso duas vezes. */
  const responsaveis = db.todos(
    `SELECT DISTINCT ct.nome, ct.email, ct.telefone
       FROM inscricoes i
       JOIN times t  ON t.id = i.time_id
       JOIN contas ct ON ct.id = t.conta_id
      WHERE i.campeonato_id = ? AND i.status <> 'cancelada' AND ct.arquivado_em IS NULL`,
    linha.id
  );

  return {
    admin: disparar('adm-inscricoes-encerradas', admins, vars, linha.nome),
    competidores: disparar('inscricoes-encerrando', responsaveis, vars, linha.nome)
  };
}

/* --------------------------------------------------------------------------
   RANKING GLOBAL

   Escrito exclusivamente pela apuração. `camp` conta participações e `titulos`
   conta primeiros lugares; vitórias e derrotas vêm dos resultados e não são
   tocadas aqui.
   -------------------------------------------------------------------------- */

function aplicarNoRanking(modalidadeId, classificacao) {
  classificacao.forEach((item) => {
    db.executar(
      `INSERT INTO ranking (modalidade, nome, uf, camp, titulos)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (modalidade, nome) DO UPDATE
          SET camp = camp + 1,
              titulos = titulos + excluded.titulos,
              uf = COALESCE(excluded.uf, ranking.uf)`,
      modalidadeId, item.nome, item.uf, item.pos === 1 ? 1 : 0
    );
  });
}

/**
 * Desfaz uma apuração anterior do MESMO campeonato. Sem isso, reapurar (o admin
 * corrigindo a ordem depois de publicada) contaria a edição duas vezes no
 * ranking. Nunca deixa o contador negativo.
 */
function reverterDoRanking(modalidadeId, classificacao) {
  classificacao.forEach((item) => {
    db.executar(
      `UPDATE ranking
          SET camp = MAX(camp - 1, 0),
              titulos = MAX(titulos - ?, 0)
        WHERE modalidade = ? AND nome = ?`,
      item.pos === 1 ? 1 : 0, modalidadeId, item.nome
    );
  });
}

/**
 * Renumera a coluna `posicao` da modalidade pela pontuação configurada em
 * Admin → Ranking. Quem ainda não atingiu o mínimo de campeonatos fica sem
 * posição (o front-end joga os sem posição para o fim da tabela).
 */
function recalcularPosicoes(modalidadeId) {
  const cfg = db.um('SELECT * FROM ranking_config WHERE modalidade = ?', modalidadeId) || {};
  const peso = {
    vitoria: cfg.pontos_vitoria ?? 3,
    empate: cfg.pontos_empate ?? 1,
    derrota: cfg.pontos_derrota ?? 0,
    titulo: cfg.bonus_titulo ?? 10,
    gotf: cfg.bonus_gotf ?? 5,
    minimo: cfg.min_campeonatos ?? 1
  };

  /* Ranking desligado para a modalidade: nada a renumerar. */
  if (cfg.ativo === 0) return;

  const linhas = db.todos('SELECT * FROM ranking WHERE modalidade = ?', modalidadeId);
  const pontos = (l) => l.v * peso.vitoria + l.e * peso.empate + l.d * peso.derrota
    + l.titulos * peso.titulo + (l.gotf ? peso.gotf : 0);

  const classificados = linhas.filter((l) => l.camp >= peso.minimo);
  classificados.sort((a, b) =>
    pontos(b) - pontos(a)
    || b.titulos - a.titulos
    || b.v - a.v
    || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  classificados.forEach((l, i) => {
    db.executar('UPDATE ranking SET posicao = ? WHERE id = ?', i + 1, l.id);
  });

  const semPosicao = linhas.filter((l) => l.camp < peso.minimo);
  semPosicao.forEach((l) => {
    db.executar('UPDATE ranking SET posicao = NULL WHERE id = ?', l.id);
  });
}

/* --------------------------------------------------------------------------
   CLASSIFICAÇÃO
   -------------------------------------------------------------------------- */

function ufDe(valor, posicao) {
  const uf = String(valor || '').trim().toUpperCase();
  if (!uf) return null;
  if (!/^[A-Z]{2}$/.test(uf)) {
    throw erro400(`UF inválida na ${posicao}ª colocação: use a sigla de dois caracteres.`);
  }
  return uf;
}

/**
 * Normaliza a ordenação manual do administrador: aceita `pos` explícito ou a
 * ordem do array, recusa nome repetido e devolve as colocações renumeradas de 1
 * a N — é essa lista que vira ranking, então não pode ter buraco nem empate.
 */
function normalizarClassificacao(bruta) {
  if (!Array.isArray(bruta) || !bruta.length) {
    throw erro400('Envie a classificação final, do primeiro ao último colocado.');
  }
  if (bruta.length > MAX_COLOCACOES) {
    throw erro400(`A classificação aceita no máximo ${MAX_COLOCACOES} colocações.`);
  }

  const nomes = new Set();
  const posicoes = new Set();

  const itens = bruta.map((item, i) => {
    const nome = String((item && item.nome) || '').trim();
    if (!nome) throw erro400(`A ${i + 1}ª colocação está sem o nome do time ou atleta.`);

    const chave = nome.toLowerCase();
    if (nomes.has(chave)) throw erro400(`"${nome}" aparece mais de uma vez na classificação.`);
    nomes.add(chave);

    const pos = Number(item.pos);
    const posicao = Number.isInteger(pos) && pos > 0 ? pos : i + 1;
    if (posicoes.has(posicao)) throw erro400(`Há mais de um colocado na ${posicao}ª posição.`);
    posicoes.add(posicao);

    return { pos: posicao, nome, uf: ufDe(item.uf, posicao) };
  });

  itens.sort((a, b) => a.pos - b.pos);
  return itens.map((item, i) => ({ pos: i + 1, nome: item.nome, uf: item.uf }));
}

/* ==========================================================================
   ROTAS PÚBLICAS
   ========================================================================== */

async function listar(ctx) {
  const status = ctx.query.get('status');
  const modalidadeId = ctx.query.get('modalidade');

  const onde = ['arquivado_em IS NULL'];
  const params = [];

  if (status) {
    if (!regras.STATUS_CAMPEONATO[status]) {
      throw erro400(`Status desconhecido: "${status}". Use um destes: ${Object.keys(regras.STATUS_CAMPEONATO).join(', ')}.`);
    }
    onde.push('status = ?');
    params.push(status);
  }
  if (modalidadeId) {
    onde.push('modalidade = ?');
    params.push(exigirModalidade(modalidadeId));
  }

  /* Encerrados no fim e, dentro de cada grupo, o evento mais próximo primeiro —
     a mesma ordem que a home e a página de inscrições esperam. */
  const linhas = db.todos(
    `SELECT * FROM campeonatos
      WHERE ${onde.join(' AND ')}
      ORDER BY (status = 'encerrado'), data, id`,
    ...params
  );

  const cont = contagensDeTodos();
  ctx.ok({
    ok: true,
    total: linhas.length,
    campeonatos: linhas.map((l) => mapa.campeonato(l, cont[l.id]))
  });
}

async function abertas(ctx) {
  const linhas = db.todos(
    `SELECT * FROM campeonatos
      WHERE arquivado_em IS NULL AND status = 'inscricoes'
      ORDER BY encerramento_inscricoes, data, id`
  );

  /* Status 'inscricoes' não basta: o prazo do briefing também conta, e é
     regras.inscricaoAberta quem sabe disso. A home esconde a seção inteira
     quando esta lista vem vazia. */
  const cont = contagensDeTodos();
  const campeonatos = linhas
    .filter((l) => regras.inscricaoAberta(l).aberta)
    .map((l) => mapa.campeonato(l, cont[l.id]));

  ctx.ok({ ok: true, total: campeonatos.length, campeonatos });
}

async function detalhar(ctx) {
  const linha = buscar(ctx.params.id, { comArquivado: ehAdmin(ctx) });
  ctx.ok({
    ok: true,
    campeonato: paraFront(linha),
    inscricao: regras.inscricaoAberta(linha)
  });
}

/* ==========================================================================
   ROTAS DO ADMINISTRADOR
   ========================================================================== */

async function criar(ctx) {
  ctx.exigirAdmin('campeonatos:criar');
  const corpo = await ctx.corpo();

  const nome = String(corpo.nome || '').trim();
  if (!nome) throw erro400('Informe o nome do campeonato.');

  const modalidadeId = exigirModalidade(corpo.modalidade);
  const limites = limitesDoCampeonato(modalidadeId, corpo);
  exigirDatasCoerentes(corpo);

  const id = idEscolhido(corpo, nome);
  const linha = mapa.paraLinhaCampeonato(
    { ...corpo, ...limites, nome, modalidade: modalidadeId, status: 'rascunho', classificacao: null },
    { id, criadoEm: db.agora() }
  );

  const criado = db.transacao(() => {
    inserirLinha(linha);
    regras.registrar(ctx, 'campeonato', nome, 'criou',
      `${regras.modalidade(modalidadeId).curto} · ${linha.vagas} vaga(s)`);
    return buscar(id);
  });

  ctx.json(201, { ok: true, campeonato: paraFront(criado) });
}

async function editar(ctx) {
  ctx.exigirAdmin('campeonatos:editar');
  const corpo = await ctx.corpo();
  const linha = buscar(ctx.params.id, { comArquivado: true });

  /* Estes campos têm porta própria (status, apuração, arquivamento) ou são
     derivados das inscrições — aceitar aqui abriria caminho para burlar as
     transições e o ranking. */
  ['status', 'classificacao', 'arquivado', 'arquivadoEm',
    'inscritos', 'oficial', 'espera', 'id', 'criadoEm'].forEach((k) => { delete corpo[k]; });

  const atual = mapa.campeonato(linha);
  let modalidadeId = linha.modalidade;

  if (corpo.modalidade && corpo.modalidade !== linha.modalidade) {
    modalidadeId = exigirModalidade(corpo.modalidade);
    /* Trocar de modalidade muda o formulário de inscrição e as regras de
       elenco: só antes de publicar e sem ninguém inscrito. */
    if (linha.status !== 'rascunho') {
      throw erro409('A modalidade só pode ser trocada enquanto o campeonato está em rascunho.');
    }
    if (db.valor('SELECT COUNT(*) FROM inscricoes WHERE campeonato_id = ?', linha.id)) {
      throw erro409('Já há times inscritos: a modalidade não pode mais ser trocada.');
    }
  }

  /* Na troca de modalidade os limites herdados não valem mais — vêm do corpo
     ou, na falta dele, da nova modalidade. */
  const base = modalidadeId === linha.modalidade ? { ...atual, ...corpo } : { ...corpo };
  const limites = limitesDoCampeonato(modalidadeId, base);

  const mesclado = { ...atual, ...corpo, ...limites, modalidade: modalidadeId };
  if (!String(mesclado.nome || '').trim()) throw erro400('Informe o nome do campeonato.');
  exigirDatasCoerentes(mesclado);

  const nova = mapa.paraLinhaCampeonato(
    { ...mesclado, status: linha.status, classificacao: db.json(linha.classificacao) },
    { id: linha.id, criadoEm: linha.criado_em }
  );

  const salvo = db.transacao(() => {
    atualizarLinha(linha.id, nova);
    regras.registrar(ctx, 'campeonato', nova.nome, 'editou',
      modalidadeId === linha.modalidade ? null : `modalidade: ${linha.modalidade} → ${modalidadeId}`);
    return buscar(linha.id, { comArquivado: true });
  });

  ctx.ok({ ok: true, campeonato: paraFront(salvo) });
}

async function mudarStatus(ctx) {
  ctx.exigirAdmin('campeonatos:status');
  const corpo = await ctx.corpo();
  const linha = buscar(ctx.params.id);

  const novo = String(corpo.status || '').trim();
  regras.exigirTransicao(linha.status, novo);

  if (novo === linha.status) {
    ctx.ok({ ok: true, campeonato: paraFront(linha), emails: { admin: 0, competidores: 0 } });
    return;
  }
  if (novo === 'inscricoes') exigirDadosParaPublicar(linha);

  const resultado = db.transacao(() => {
    db.executar(
      'UPDATE campeonatos SET status = ?, atualizado_em = ? WHERE id = ?',
      novo, db.agora(), linha.id
    );
    regras.registrar(ctx, 'campeonato', linha.nome, ACAO_DO_STATUS[novo] || 'mudou o status',
      `${regras.STATUS_CAMPEONATO[linha.status].rotulo} → ${regras.STATUS_CAMPEONATO[novo].rotulo}`);

    /* Encerrar as inscrições avisa os dois lados: o alerta interno e o aviso ao
       responsável, que a partir de agora só altera o time por chamado. */
    const emails = novo === 'fechado'
      ? avisarEncerramentoDasInscricoes(linha)
      : { admin: 0, competidores: 0 };

    return { emails, linha: buscar(linha.id) };
  });

  ctx.ok({ ok: true, campeonato: paraFront(resultado.linha), emails: resultado.emails });
}

async function apurar(ctx) {
  ctx.exigirAdmin('campeonatos:apurar');
  const corpo = await ctx.corpo();
  const linha = buscar(ctx.params.id, { comArquivado: true });

  if (!['andamento', 'encerrado'].includes(linha.status)) {
    throw erro409(
      `A apuração só acontece com o campeonato em andamento ou já encerrado. ` +
      `Situação atual: ${regras.STATUS_CAMPEONATO[linha.status].rotulo}.`
    );
  }

  const classificacao = normalizarClassificacao(corpo.classificacao);

  const resultado = db.transacao(() => {
    const anterior = db.json(linha.classificacao);
    if (Array.isArray(anterior) && anterior.length) {
      reverterDoRanking(linha.modalidade, anterior);
    }
    aplicarNoRanking(linha.modalidade, classificacao);
    recalcularPosicoes(linha.modalidade);

    /* Apurar é o último passo do ciclo: quem ainda estava em andamento passa a
       encerrado no mesmo movimento. */
    const status = linha.status === 'andamento' ? 'encerrado' : linha.status;
    if (status !== linha.status) regras.exigirTransicao(linha.status, status);

    db.executar(
      'UPDATE campeonatos SET classificacao = ?, status = ?, atualizado_em = ? WHERE id = ?',
      db.paraJson(classificacao), status, db.agora(), linha.id
    );

    regras.registrar(ctx, 'campeonato', linha.nome, anterior ? 'reapurou' : 'apurou',
      `campeão: ${classificacao[0].nome} · ${classificacao.length} colocação(ões)`);
    regras.registrar(ctx, 'ranking', regras.modalidade(linha.modalidade).curto, 'atualizou',
      `apuração de ${linha.nome}`);

    return buscar(linha.id, { comArquivado: true });
  });

  const ranking = db.todos(
    `SELECT * FROM ranking WHERE modalidade = ?
      ORDER BY COALESCE(posicao, 9999), v DESC, nome`,
    linha.modalidade
  );

  ctx.ok({
    ok: true,
    campeonato: paraFront(resultado),
    ranking: mapa.lista(ranking, mapa.rankingLinha)
  });
}

async function duplicar(ctx) {
  ctx.exigirAdmin('campeonatos:criar');
  const corpo = await ctx.corpo();
  /* Aceita { ajustes: {…} } e também os campos soltos na raiz. */
  const ajustes = corpo.ajustes && typeof corpo.ajustes === 'object' ? corpo.ajustes : corpo;

  const origem = buscar(ctx.params.id, { comArquivado: true });
  const anterior = mapa.campeonato(origem);

  const nome = String(ajustes.nome || `${origem.nome} (cópia)`).trim();

  /* Cada edição repete as regras da anterior — elenco, termos, premiação e
     regulamento. O que NÃO se herda: datas, listas e a situação da edição
     passada; a cópia nasce em rascunho e com o calendário em branco. */
  const copia = {
    ...anterior,
    nome,
    data: ajustes.data || null,
    dataFim: ajustes.dataFim || null,
    aberturaInscricoes: ajustes.aberturaInscricoes || null,
    encerramentoInscricoes: ajustes.encerramentoInscricoes || null,
    local: ajustes.local || anterior.local,
    vagas: ajustes.vagas === undefined ? anterior.vagas : Number(ajustes.vagas) || 0,
    status: 'rascunho',
    classificacao: null
  };
  exigirDatasCoerentes(copia);

  const id = idEscolhido(ajustes, nome);
  const linha = mapa.paraLinhaCampeonato(copia, { id, criadoEm: db.agora() });

  const criado = db.transacao(() => {
    inserirLinha(linha);
    regras.registrar(ctx, 'campeonato', nome, 'duplicou', `a partir de "${origem.nome}"`);
    return buscar(id);
  });

  ctx.json(201, { ok: true, campeonato: paraFront(criado), origem: origem.id });
}

async function arquivar(ctx) {
  ctx.exigirAdmin('campeonatos:arquivar');
  const linha = buscar(ctx.params.id);

  /* Arquivamento é lógico (o histórico do admin restaura), mas um campeonato no
     ar sumiria do site com inscrição ou disputa em curso. */
  if (['inscricoes', 'andamento'].includes(linha.status)) {
    throw erro409(
      `Encerre antes o campeonato: não dá para arquivar com a situação "${regras.STATUS_CAMPEONATO[linha.status].rotulo}".`
    );
  }

  const agora = db.agora();
  db.transacao(() => {
    db.executar(
      'UPDATE campeonatos SET arquivado_em = ?, atualizado_em = ? WHERE id = ?',
      agora, agora, linha.id
    );
    regras.registrar(ctx, 'campeonato', linha.nome, 'arquivou',
      regras.STATUS_CAMPEONATO[linha.status].rotulo);
  });

  ctx.ok({ ok: true, campeonato: paraFront(buscar(linha.id, { comArquivado: true })) });
}

/* --------------------------------------------------------------------------
   INSCRITOS E EXPORTAÇÃO
   -------------------------------------------------------------------------- */

/** Times inscritos no campeonato, filtrados por lista, já montados. */
function timesInscritos(campeonatoId, status) {
  const filtro = status.length ? `AND i.status IN (${marcadores(status)})` : "AND i.status <> 'cancelada'";
  const linhas = db.todos(
    `SELECT t.* FROM times t
       JOIN inscricoes i ON i.time_id = t.id
      WHERE i.campeonato_id = ? ${filtro}
      ORDER BY i.data, i.protocolo`,
    campeonatoId, ...status
  );
  return montarTimes(linhas);
}

async function inscritos(ctx) {
  ctx.exigirAdmin('inscricoes:ler');
  const linha = buscar(ctx.params.id, { comArquivado: true });

  const registros = db.todos(
    `SELECT i.*, ct.id AS conta_id, ct.nome AS resp_nome,
            ct.email AS resp_email, ct.telefone AS resp_telefone
       FROM inscricoes i
       JOIN times t   ON t.id = i.time_id
       LEFT JOIN contas ct ON ct.id = t.conta_id
      WHERE i.campeonato_id = ?
      ORDER BY i.data, i.protocolo`,
    linha.id
  );

  const times = {};
  timesInscritos(linha.id, []).forEach((t) => { times[t.id] = t; });
  /* A consulta acima ignora canceladas; o time delas ainda precisa aparecer. */
  const faltantes = registros
    .filter((r) => !times[r.time_id])
    .map((r) => r.time_id);
  if (faltantes.length) {
    montarTimes(db.todos(
      `SELECT * FROM times WHERE id IN (${marcadores(faltantes)})`, ...faltantes
    )).forEach((t) => { times[t.id] = t; });
  }

  const listas = { triagem: [], oficial: [], espera: [], cancelada: [] };

  registros.forEach((r) => {
    const time = times[r.time_id] || null;
    const titulares = time ? time.jogadores.filter((j) => !j.reserva).length : 0;
    const reservas = time ? time.jogadores.filter((j) => j.reserva).length : 0;

    listas[r.status].push({
      ...mapa.inscricao(r),
      time,
      responsavel: r.conta_id
        ? { id: r.conta_id, nome: r.resp_nome, email: r.resp_email, telefone: r.resp_telefone }
        : null,
      /* A triagem do admin precisa ver de cara quem está com elenco incompleto. */
      elenco: time
        ? { ...regras.validarElenco(time.modalidade, titulares, reservas), titulares, reservas }
        : null
    });
  });

  ctx.ok({
    ok: true,
    campeonato: paraFront(linha),
    totais: {
      inscritos: listas.triagem.length + listas.oficial.length + listas.espera.length,
      triagem: listas.triagem.length,
      oficial: listas.oficial.length,
      espera: listas.espera.length,
      cancelada: listas.cancelada.length
    },
    listas
  });
}

const LISTAS_EXPORTAVEIS = {
  oficial: ['oficial'],
  espera: ['espera'],
  triagem: ['triagem'],
  todas: ['triagem', 'oficial', 'espera']
};

/**
 * Devolve o material do .zip; o arquivo em si é montado no navegador por
 * assets/js/exportar.js, que espera exatamente as formas de mapa.campeonato e
 * mapa.time. Nada de gerar zip aqui.
 */
async function exportar(ctx) {
  ctx.exigirAdmin('campeonatos:exportar');
  const linha = buscar(ctx.params.id, { comArquivado: true });

  const lista = ctx.query.get('lista') || 'oficial';
  if (!LISTAS_EXPORTAVEIS[lista]) {
    throw erro400(`Lista desconhecida: "${lista}". Use ${Object.keys(LISTAS_EXPORTAVEIS).join(', ')}.`);
  }

  let times = timesInscritos(linha.id, LISTAS_EXPORTAVEIS[lista]);

  /* Exportação de um time só (a tela do time tem o próprio botão). */
  const timeId = ctx.query.get('time');
  if (timeId) {
    times = times.filter((t) => t.id === timeId);
    if (!times.length) throw erro404('Este time não está nesta lista do campeonato.');
  }

  /* Exportação carrega dado pessoal (e-mail, telefone, nascimento, foto): fica
     registrado quem baixou. */
  regras.registrar(ctx, 'campeonato', linha.nome, 'exportou',
    `${times.length} time(s) · lista ${lista}${timeId ? ` · time ${timeId}` : ''}`);

  ctx.ok({
    ok: true,
    campeonato: paraFront(linha),
    times,
    lista,
    /* Campeonato de dança não tem pasta por atleta nem aba por time. */
    danca: linha.modalidade === 'dance'
  });
}

/* ==========================================================================
   REGISTRO
   ========================================================================== */

function registrar(rotas) {
  /* '/abertas' antes de '/:id': o roteador devolve a primeira rota que casa, e
     o padrão com parâmetro engoliria o caminho fixo. */
  rotas.get('/api/campeonatos', listar);
  rotas.get('/api/campeonatos/abertas', abertas);
  rotas.get('/api/campeonatos/:id', detalhar);

  rotas.post('/api/campeonatos', criar);
  rotas.put('/api/campeonatos/:id', editar);
  rotas.post('/api/campeonatos/:id/status', mudarStatus);
  rotas.post('/api/campeonatos/:id/apuracao', apurar);
  rotas.post('/api/campeonatos/:id/duplicar', duplicar);
  rotas.delete('/api/campeonatos/:id', arquivar);

  rotas.get('/api/campeonatos/:id/inscritos', inscritos);
  rotas.get('/api/campeonatos/:id/exportar', exportar);
}

module.exports = { registrar };
