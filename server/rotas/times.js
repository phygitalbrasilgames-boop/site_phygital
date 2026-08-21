/* ==========================================================================
   PHYGITAL BRASIL — TIMES, ELENCO E DOCUMENTAÇÃO

   O time é o objeto mais sensível do painel do competidor: é dele que saem a
   inscrição, o export com as fotos e a conferência de documentos. Três regras
   atravessam TODAS as rotas deste arquivo:

   1. Propriedade. O id da URL nunca decide sozinho o que a consulta devolve —
      a conta da sessão entra no WHERE. Quem não é dono recebe 404, não 403:
      responder "sem permissão" confirmaria que aquele id existe.
   2. Trava de edição. Passada a data de encerramento das inscrições, qualquer
      alteração de time, jogador ou comissão só por chamado. Toda escrita passa
      por regras.exigirEdicaoLiberada() antes de tocar no banco.
   3. Limites da modalidade. Titulares, reservas e comissão têm teto próprio
      por modalidade, e o teto é conferido no servidor — a validação da tela é
      conveniência, não garantia.

   O envio de documento é a única escrita que NÃO respeita a trava, e isso é
   proposital: ver a nota em PUT .../documentos/:tipo.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const mapa = require('../mapa');
const regras = require('../regras');
const { erro400, erro404, erro409, CORPO_MAX_UPLOAD } = require('../http');

/* --------------------------------------------------------------------------
   APOIO
   -------------------------------------------------------------------------- */

/* Prefixo + UUID: o id fica legível no banco ('t-8f3a…') sem depender de
   contador, que colidiria com dois cadastros simultâneos. */
const novoId = (prefixo) => `${prefixo}-${crypto.randomUUID()}`;

/** Texto aparado; string vazia vira null para não gravar '' no lugar de NULL. */
function texto(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
}

/**
 * Valor de um campo em atualização parcial: chave ausente no corpo mantém o
 * que já está gravado; chave presente (mesmo vazia) sobrescreve.
 */
function campo(corpo, chave, atual) {
  if (corpo[chave] === undefined) return atual === undefined ? null : atual;
  return texto(corpo[chave]);
}

/* Data só é conferida quando VEM no corpo: recusar o que já está gravado
   deixaria o cadastro sem saída se um dado antigo estiver fora do formato. */
function campoData(corpo, chave, atual, rotulo) {
  if (corpo[chave] === undefined) return atual === undefined ? null : (atual || null);
  return exigirData(texto(corpo[chave]), rotulo);
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function exigirData(valor, rotulo) {
  if (!valor) return null;
  if (!DATA_ISO.test(valor) || Number.isNaN(new Date(`${valor}T00:00:00`).getTime())) {
    throw erro400(`${rotulo} deve estar no formato AAAA-MM-DD.`);
  }
  return valor;
}

/**
 * INSERT montado a partir das chaves do objeto. Nome de tabela e de coluna vêm
 * de literais deste arquivo e das funções paraLinha* de mapa.js; os valores
 * sempre viajam como parâmetro, nunca interpolados.
 */
function inserir(tabela, linha) {
  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO ${tabela} (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );
}

function atualizar(tabela, linha, id) {
  const colunas = Object.keys(linha).filter((c) => c !== 'id');
  db.executar(
    `UPDATE ${tabela} SET ${colunas.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
    ...colunas.map((c) => linha[c]), id
  );
}

/* O painel mostra quando o time foi atualizado pela última vez, e mexer no
   elenco é mexer no time. */
const tocarTime = (id) => db.executar(
  'UPDATE times SET atualizado_em = ? WHERE id = ?', db.agora(), id
);

/** Colunas que realmente mudaram — vira o detalhe do registro de auditoria. */
function camposAlterados(linha, atual) {
  return Object.keys(linha).filter((c) => {
    if (c === 'atualizado_em' || c === 'id') return false;
    const antes = atual[c] === null || atual[c] === undefined ? '' : String(atual[c]);
    const depois = linha[c] === null || linha[c] === undefined ? '' : String(linha[c]);
    return antes !== depois;
  });
}

/* --------------------------------------------------------------------------
   ACESSO AO TIME

   Nada neste arquivo carrega um time sem passar por aqui.
   -------------------------------------------------------------------------- */

function exigirTime(id) {
  const time = db.um('SELECT * FROM times WHERE id = ? AND arquivado_em IS NULL', id);
  if (!time) throw erro404('Time não encontrado.');
  return time;
}

/* conta_id no WHERE, e não uma comparação depois da consulta: assim não existe
   caminho em que um id de outra conta seja lido por engano. */
function timeDoDono(conta, id) {
  const time = db.um(
    'SELECT * FROM times WHERE id = ? AND conta_id = ? AND arquivado_em IS NULL', id, conta.id
  );
  if (!time) throw erro404('Time não encontrado.');
  return time;
}

/** Leitura: o dono, ou um administrador com permissão de ler times. */
function timeParaLeitura(ctx, id) {
  const conta = ctx.exigirLogin();
  if (conta.papel === 'admin') {
    ctx.exigirAdmin('times:ler');
    return exigirTime(id);
  }
  return timeDoDono(conta, id);
}

/**
 * Escrita: só o competidor dono, e só com a edição liberada.
 * O administrador não escreve no elenco de ninguém — quando o prazo fecha, a
 * alteração passa por chamado, que é o rastro que o briefing exige.
 */
function timeParaEscrita(ctx, id) {
  const conta = ctx.exigirCompetidor();
  const time = timeDoDono(conta, id);
  regras.exigirEdicaoLiberada(time.id);
  return time;
}

function exigirJogador(timeId, jogadorId) {
  const jogador = db.um(
    'SELECT * FROM jogadores WHERE id = ? AND time_id = ?', jogadorId, timeId
  );
  if (!jogador) throw erro404('Jogador não encontrado neste time.');
  return jogador;
}

function exigirStaff(timeId, staffId) {
  const membro = db.um('SELECT * FROM staff WHERE id = ? AND time_id = ?', staffId, timeId);
  if (!membro) throw erro404('Integrante da comissão não encontrado neste time.');
  return membro;
}

/* --------------------------------------------------------------------------
   MONTAGEM DO TIME COMPLETO

   O front-end espera o elenco aninhado dentro do time (mapa.time). As três
   consultas são feitas em lote para a listagem não virar N+1.
   -------------------------------------------------------------------------- */

const marcadores = (ids) => ids.map(() => '?').join(', ');

function montarTimes(linhas) {
  if (!linhas.length) return [];

  const ids = linhas.map((t) => t.id);
  const marca = marcadores(ids);

  /* Reservas no fim e, dentro de cada grupo, na ordem de cadastro: é o índice
     que as telas usam e a sequência que o export segue ao nomear as fotos. */
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

  const porTime = {};
  const staffPorTime = {};
  const docsPorJogador = {};
  jogadores.forEach((j) => { (porTime[j.time_id] = porTime[j.time_id] || []).push(j); });
  equipe.forEach((s) => { (staffPorTime[s.time_id] = staffPorTime[s.time_id] || []).push(s); });
  documentos.forEach((d) => {
    (docsPorJogador[d.jogador_id] = docsPorJogador[d.jogador_id] || []).push(d);
  });

  return linhas.map((t) => mapa.time(
    t, porTime[t.id] || [], staffPorTime[t.id] || [], docsPorJogador
  ));
}

const montarTime = (linha) => montarTimes([linha])[0];

/* --------------------------------------------------------------------------
   REGRAS DA MODALIDADE
   -------------------------------------------------------------------------- */

/* regras.modalidade() cai em 'outros' quando não conhece o id. Isso é bom na
   leitura de um dado antigo, mas na criação esconderia um erro de digitação
   atrás de limites que não são os da modalidade pedida. */
function exigirModalidade(id) {
  const chave = String(id || '').trim();
  if (!Object.prototype.hasOwnProperty.call(regras.MODALIDADES, chave)) {
    throw erro400(
      `Modalidade desconhecida: "${chave}". Use uma destas: ${Object.keys(regras.MODALIDADES).join(', ')}.`
    );
  }
  return regras.MODALIDADES[chave];
}

/** Categoria só existe onde a modalidade prevê (hoje, futebol). */
function categoriaDoTime(m, valor, atual = null) {
  if (!m.temCategoria) return null;

  const escolhida = valor === undefined ? atual : texto(valor);
  if (!escolhida) {
    throw erro400(`Escolha a categoria do time em ${m.curto}: ${m.categorias.join(', ')}.`);
  }
  if (!m.categorias.includes(escolhida)) {
    throw erro400(`Categoria inválida para ${m.curto}. Use uma destas: ${m.categorias.join(', ')}.`);
  }
  return escolhida;
}

/* O formulário de time é uma tela só, mas elenco tem rota própria: aceitar a
   lista aqui apagaria em silêncio jogadores (e os documentos deles, que caem
   por CASCADE) que não viessem no corpo. */
function recusarElencoNoCorpo(corpo) {
  if (corpo.jogadores !== undefined || corpo.staff !== undefined) {
    throw erro400(
      'Jogadores e comissão não são gravados por esta rota. Use /api/times/:id/jogadores e /api/times/:id/staff.'
    );
  }
}

function exigirVagaDeJogador(m, timeId, reserva, ignorarId = null) {
  let sql = 'SELECT COUNT(*) FROM jogadores WHERE time_id = ? AND reserva = ?';
  const params = [timeId, db.paraBool(reserva)];
  if (ignorarId) { sql += ' AND id != ?'; params.push(ignorarId); }

  const atuais = db.valor(sql, ...params) || 0;
  const teto = reserva ? m.reservasMax : m.jogadoresMax;

  if (reserva && teto === 0) throw erro409(`O ${m.nome} não trabalha com reservas.`);
  if (atuais >= teto) {
    throw erro409(reserva
      ? `O ${m.nome} aceita no máximo ${teto} reserva(s) — já são ${atuais}.`
      : `O ${m.nome} aceita no máximo ${teto} jogador(es) titular(es) — já são ${atuais}.`);
  }
}

function exigirVagaDeStaff(m, timeId, ignorarId = null) {
  let sql = 'SELECT COUNT(*) FROM staff WHERE time_id = ?';
  const params = [timeId];
  if (ignorarId) { sql += ' AND id != ?'; params.push(ignorarId); }

  const atuais = db.valor(sql, ...params) || 0;
  if (atuais >= m.staffMax) {
    throw erro409(
      `A comissão do ${m.nome} tem no máximo ${m.staffMax} integrante(s) (${m.staffRotulo}) — já são ${atuais}.`
    );
  }
}

/**
 * Campo que a modalidade não prevê é gravado como NULL, não como veio: número
 * de camisa em shooter ou Steam64 em futebol viraria ruído no export, que lê a
 * coluna direto.
 */
function normalizarJogador(m, corpo, atual = {}) {
  const numeroBruto = corpo.numero === undefined ? atual.numero : corpo.numero;
  let numero = null;

  if (m.temNumeroCamisa && numeroBruto !== null && numeroBruto !== undefined && numeroBruto !== '') {
    numero = Number(numeroBruto);
    if (!Number.isInteger(numero) || numero < 0) {
      throw erro400('O número da camisa deve ser um número inteiro.');
    }
  }

  return {
    nome: campo(corpo, 'nome', atual.nome),
    apelido: campo(corpo, 'apelido', atual.apelido),
    email: campo(corpo, 'email', atual.email),
    tel: campo(corpo, 'tel', atual.tel),
    nasc: exigirData(campo(corpo, 'nasc', atual.nasc), 'A data de nascimento'),
    insta: campo(corpo, 'insta', atual.insta),
    foto: campo(corpo, 'foto', atual.foto),
    numero,
    funcao: m.temFuncao ? campo(corpo, 'funcao', atual.funcao) : null,
    steam: m.temSteam ? campo(corpo, 'steam', atual.steam) : null,
    faceit: m.temSteam ? campo(corpo, 'faceit', atual.faceit) : null
  };
}

function validarJogadorOuFalhar(m, dados) {
  const veredito = regras.validarJogador(m.id, dados);
  if (!veredito.valido) throw erro400(veredito.erros.join(' '), { erros: veredito.erros });
}

function normalizarStaff(corpo, atual = {}) {
  return {
    nome: campo(corpo, 'nome', atual.nome),
    papel: campo(corpo, 'papel', atual.papel),
    email: campo(corpo, 'email', atual.email),
    tel: campo(corpo, 'tel', atual.tel),
    nasc: exigirData(campo(corpo, 'nasc', atual.nasc), 'A data de nascimento'),
    insta: campo(corpo, 'insta', atual.insta),
    foto: campo(corpo, 'foto', atual.foto)
  };
}

/* --------------------------------------------------------------------------
   ROTAS
   -------------------------------------------------------------------------- */

function registrar(rotas) {

  /* ---------------------------------------------------------------- TIMES */

  rotas.get('/api/times', async (ctx) => {
    const conta = ctx.exigirLogin();

    if (conta.papel !== 'admin') {
      return ctx.ok({
        ok: true,
        times: montarTimes(db.todos(
          `SELECT * FROM times
            WHERE conta_id = ? AND arquivado_em IS NULL
            ORDER BY criado_em, id`, conta.id
        ))
      });
    }

    ctx.exigirAdmin('times:ler');

    /* Os filtros entram como fragmentos fixos; o valor vai por parâmetro. */
    const condicoes = [];
    const params = [];
    const porConta = ctx.query.get('conta');
    const porModalidade = ctx.query.get('modalidade');
    if (porConta) { condicoes.push('conta_id = ?'); params.push(porConta); }
    if (porModalidade) { condicoes.push('modalidade = ?'); params.push(porModalidade); }

    const filtro = condicoes.length ? ` AND ${condicoes.join(' AND ')}` : '';

    const times = montarTimes(db.todos(
      `SELECT * FROM times WHERE arquivado_em IS NULL${filtro} ORDER BY criado_em, id`, ...params
    ));

    /* Painel do administrador precisa mostrar o responsável do time (nome e
       e-mail da conta dona), não só o id. Busca em lote para não virar N+1. */
    if (times.length) {
      const contaIds = [];
      const vistos = {};
      times.forEach((t) => {
        if (t.conta && !vistos[t.conta]) { vistos[t.conta] = true; contaIds.push(t.conta); }
      });
      if (contaIds.length) {
        const donos = db.todos(
          `SELECT id, nome, email, telefone FROM contas WHERE id IN (${marcadores(contaIds)})`,
          ...contaIds
        );
        const porId = {};
        donos.forEach((d) => { porId[d.id] = d; });
        times.forEach((t) => {
          const d = porId[t.conta];
          if (d) {
            t.contaNome = d.nome;
            t.contaEmail = d.email;
            t.contaTelefone = d.telefone;
          }
        });
      }
    }

    return ctx.ok({ ok: true, times });
  });

  rotas.get('/api/times/:id', async (ctx) => {
    const time = timeParaLeitura(ctx, ctx.params.id);
    return ctx.ok({ ok: true, time: montarTime(time) });
  });

  rotas.post('/api/times', async (ctx) => {
    const conta = ctx.exigirCompetidor();
    /* O escudo chega como data URI no mesmo corpo do formulário. */
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);
    recusarElencoNoCorpo(corpo);

    const nome = texto(corpo.nome);
    if (!nome) throw erro400('Informe o nome do time.');

    const m = exigirModalidade(corpo.modalidade);
    const categoria = categoriaDoTime(m, corpo.categoria);

    const id = novoId('t');
    const linha = mapa.paraLinhaTime(
      { ...corpo, nome, modalidade: m.id, categoria },
      { id, contaId: conta.id, criadoEm: db.agora() }
    );

    db.transacao(() => {
      inserir('times', linha);
      regras.registrar(ctx, 'time', nome, 'criou', m.nome);
    });

    return ctx.json(201, { ok: true, time: montarTime(exigirTime(id)) });
  });

  rotas.put('/api/times/:id', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);
    recusarElencoNoCorpo(corpo);

    const m = regras.modalidade(time.modalidade);

    /* Trocar de modalidade invalidaria o elenco já cadastrado (limites, camisa,
       Steam64): o caminho é criar outro time. */
    if (corpo.modalidade !== undefined && texto(corpo.modalidade) !== time.modalidade) {
      throw erro400('A modalidade do time não pode ser alterada. Cadastre um novo time.');
    }

    const nome = campo(corpo, 'nome', time.nome);
    if (!nome) throw erro400('Informe o nome do time.');

    const linha = mapa.paraLinhaTime({
      nome,
      modalidade: time.modalidade,
      categoria: categoriaDoTime(m, corpo.categoria, time.categoria),
      escudo: campo(corpo, 'escudo', time.escudo),
      descricao: campo(corpo, 'descricao', time.descricao),
      historico: campo(corpo, 'historico', time.historico)
    }, { id: time.id, contaId: time.conta_id, criadoEm: time.criado_em });

    const mudou = camposAlterados(linha, time);

    db.transacao(() => {
      atualizar('times', linha, time.id);
      regras.registrar(ctx, 'time', nome, 'alterou',
        mudou.length ? `campos: ${mudou.join(', ')}` : 'nenhum campo mudou de valor');
    });

    return ctx.ok({ ok: true, time: montarTime(exigirTime(time.id)) });
  });

  rotas.delete('/api/times/:id', async (ctx) => {
    const conta = ctx.exigirCompetidor();
    const time = timeDoDono(conta, ctx.params.id);

    const ativas = db.todos(
      `SELECT c.nome, i.protocolo, i.status
         FROM inscricoes i
         JOIN campeonatos c ON c.id = i.campeonato_id
        WHERE i.time_id = ? AND i.status != 'cancelada'`,
      time.id
    );

    /* Esta checagem vem antes da trava de edição de propósito: as duas se
       sobrepõem, e "existe inscrição ativa" diz melhor o que fazer. */
    if (ativas.length) {
      throw erro409(
        `Este time está inscrito em: ${ativas.map((i) => i.nome).join(', ')}. ` +
        'Cancele a inscrição (ou abra um chamado) antes de excluir o time.',
        { inscricoes: ativas }
      );
    }
    regras.exigirEdicaoLiberada(time.id);

    /* Exclusão lógica, como no resto do sistema: inscrições canceladas,
       chamados e auditoria continuam apontando para um time que existe. */
    db.transacao(() => {
      db.executar(
        'UPDATE times SET arquivado_em = ?, atualizado_em = ? WHERE id = ?',
        db.agora(), db.agora(), time.id
      );
      regras.registrar(ctx, 'time', time.nome, 'excluiu', regras.modalidade(time.modalidade).nome);
    });

    return ctx.ok({ ok: true, id: time.id, arquivado: true });
  });

  /* ------------------------------------------------------------ JOGADORES */

  rotas.post('/api/times/:id/jogadores', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);

    const m = regras.modalidade(time.modalidade);
    const reserva = Boolean(corpo.reserva);

    exigirVagaDeJogador(m, time.id, reserva);

    const dados = normalizarJogador(m, corpo);
    validarJogadorOuFalhar(m, dados);

    const ordem = (db.valor('SELECT MAX(ordem) FROM jogadores WHERE time_id = ?', time.id) || 0) + 1;
    const id = novoId('j');

    db.transacao(() => {
      inserir('jogadores', mapa.paraLinhaJogador(
        { ...dados, reserva }, { id, timeId: time.id, ordem }
      ));
      tocarTime(time.id);
      regras.registrar(ctx, 'jogador', time.nome, 'incluiu',
        `${dados.nome}${reserva ? ' (reserva)' : ''}`);
    });

    return ctx.json(201, {
      ok: true,
      jogador: mapa.jogador(db.um('SELECT * FROM jogadores WHERE id = ?', id), [])
    });
  });

  rotas.put('/api/times/:id/jogadores/:jogadorId', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const atual = exigirJogador(time.id, ctx.params.jogadorId);
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);

    const m = regras.modalidade(time.modalidade);
    const reserva = corpo.reserva === undefined ? db.bool(atual.reserva) : Boolean(corpo.reserva);

    /* Promover reserva a titular (ou o contrário) consome vaga do outro grupo;
       ignora o próprio jogador na contagem. */
    if (reserva !== db.bool(atual.reserva)) exigirVagaDeJogador(m, time.id, reserva, atual.id);

    const dados = normalizarJogador(m, corpo, atual);
    validarJogadorOuFalhar(m, dados);

    const linha = mapa.paraLinhaJogador(
      { ...dados, reserva }, { id: atual.id, timeId: time.id, ordem: atual.ordem }
    );
    const mudou = camposAlterados(linha, atual);

    db.transacao(() => {
      atualizar('jogadores', linha, atual.id);
      tocarTime(time.id);
      regras.registrar(ctx, 'jogador', time.nome, 'alterou',
        `${dados.nome}${mudou.length ? ` · campos: ${mudou.join(', ')}` : ''}`);
    });

    const documentos = db.todos('SELECT * FROM documentos WHERE jogador_id = ? ORDER BY tipo', atual.id);
    return ctx.ok({
      ok: true,
      jogador: mapa.jogador(db.um('SELECT * FROM jogadores WHERE id = ?', atual.id), documentos)
    });
  });

  rotas.delete('/api/times/:id/jogadores/:jogadorId', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const jogador = exigirJogador(time.id, ctx.params.jogadorId);

    /* O mínimo de titulares não é exigido aqui: um time em montagem passa boa
       parte do tempo incompleto. Quem cobra o elenco fechado é a inscrição. */
    db.transacao(() => {
      /* Os documentos do jogador caem junto por ON DELETE CASCADE. */
      db.executar('DELETE FROM jogadores WHERE id = ? AND time_id = ?', jogador.id, time.id);
      tocarTime(time.id);
      regras.registrar(ctx, 'jogador', time.nome, 'removeu', jogador.nome);
    });

    return ctx.ok({ ok: true, id: jogador.id });
  });

  /* --------------------------------------------------------------- STAFF */

  rotas.post('/api/times/:id/staff', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);

    const m = regras.modalidade(time.modalidade);
    exigirVagaDeStaff(m, time.id);

    const dados = normalizarStaff(corpo);
    if (!dados.nome) throw erro400('Informe o nome do integrante da comissão.');

    const ordem = (db.valor('SELECT MAX(ordem) FROM staff WHERE time_id = ?', time.id) || 0) + 1;
    const id = novoId('s');

    db.transacao(() => {
      inserir('staff', mapa.paraLinhaStaff(dados, { id, timeId: time.id, ordem }));
      tocarTime(time.id);
      regras.registrar(ctx, 'staff', time.nome, 'incluiu',
        `${dados.nome}${dados.papel ? ` · ${dados.papel}` : ''}`);
    });

    return ctx.json(201, {
      ok: true,
      staff: mapa.staff(db.um('SELECT * FROM staff WHERE id = ?', id))
    });
  });

  rotas.put('/api/times/:id/staff/:staffId', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const atual = exigirStaff(time.id, ctx.params.staffId);
    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);

    const dados = normalizarStaff(corpo, atual);
    if (!dados.nome) throw erro400('Informe o nome do integrante da comissão.');

    const linha = mapa.paraLinhaStaff(dados, { id: atual.id, timeId: time.id, ordem: atual.ordem });
    const mudou = camposAlterados(linha, atual);

    db.transacao(() => {
      atualizar('staff', linha, atual.id);
      tocarTime(time.id);
      regras.registrar(ctx, 'staff', time.nome, 'alterou',
        `${dados.nome}${mudou.length ? ` · campos: ${mudou.join(', ')}` : ''}`);
    });

    return ctx.ok({
      ok: true,
      staff: mapa.staff(db.um('SELECT * FROM staff WHERE id = ?', atual.id))
    });
  });

  rotas.delete('/api/times/:id/staff/:staffId', async (ctx) => {
    const time = timeParaEscrita(ctx, ctx.params.id);
    const membro = exigirStaff(time.id, ctx.params.staffId);

    db.transacao(() => {
      db.executar('DELETE FROM staff WHERE id = ? AND time_id = ?', membro.id, time.id);
      tocarTime(time.id);
      regras.registrar(ctx, 'staff', time.nome, 'removeu', membro.nome);
    });

    return ctx.ok({ ok: true, id: membro.id });
  });

  /* -------------------------------------------------------------- ELENCO */

  rotas.get('/api/times/:id/elenco', async (ctx) => {
    const time = timeParaLeitura(ctx, ctx.params.id);
    const m = regras.modalidade(time.modalidade);

    const veredito = regras.validarElencoDoTime(time.id);
    const travas = regras.travasDoTime(time.id);
    const comissao = db.valor('SELECT COUNT(*) FROM staff WHERE time_id = ?', time.id) || 0;

    return ctx.ok({
      ok: true,
      time: time.id,
      modalidade: m.id,
      /* Os limites acompanham a resposta para a tela não depender da própria
         cópia das regras ao explicar por que faltou gente. */
      limites: {
        jogadoresMin: m.jogadoresMin,
        jogadoresMax: m.jogadoresMax,
        reservasMax: m.reservasMax,
        staffMax: m.staffMax,
        staffRotulo: m.staffRotulo,
        temCategoria: Boolean(m.temCategoria),
        individual: Boolean(m.individual),
        staffOpcional: Boolean(m.staffOpcional)
      },
      titulares: veredito.titulares,
      reservas: veredito.reservas,
      staff: comissao,
      valido: veredito.valido,
      erros: veredito.erros,
      edicaoLiberada: travas.length === 0,
      travas
    });
  });

  /* -------------------------------------------------------- DOCUMENTAÇÃO */

  rotas.get('/api/times/:id/documentacao', async (ctx) => {
    const time = timeParaLeitura(ctx, ctx.params.id);

    const jogadores = db.todos(
      'SELECT * FROM jogadores WHERE time_id = ? ORDER BY reserva, ordem, id', time.id
    );
    const documentos = db.todos(
      `SELECT d.* FROM documentos d
         JOIN jogadores j ON j.id = d.jogador_id
        WHERE j.time_id = ?`, time.id
    );

    const porJogador = {};
    documentos.forEach((d) => {
      porJogador[d.jogador_id] = porJogador[d.jogador_id] || {};
      porJogador[d.jogador_id][d.tipo] = d;
    });

    const pendencias = [];
    let total = 0;
    let aprovados = 0;

    const lista = jogadores.map((j) => {
      const itens = regras.documentosExigidos(j).map((tipo) => {
        const doc = (porJogador[j.id] || {})[tipo.id] || null;
        /* 'vencido' é derivado da validade, não gravado — por isso o status
           efetivo sai daqui e não da coluna. */
        const status = regras.statusDocumento(doc);
        const rotulo = (regras.STATUS_DOCUMENTO[status] || regras.STATUS_DOCUMENTO.pendente).rotulo;

        total++;
        if (status === 'aprovado') aprovados++;
        else {
          pendencias.push({
            jogadorId: j.id, jogador: j.nome,
            tipo: tipo.id, documento: tipo.nome, status, rotulo
          });
        }

        return {
          documentoId: doc ? doc.id : null,
          tipo: tipo.id,
          nome: tipo.nome,
          descricao: tipo.descricao,
          /* documentosExigidos() só devolve o que é exigido daquele jogador —
             inclusive a autorização do responsável, quando ele é menor. */
          obrigatorio: true,
          temValidade: Boolean(tipo.temValidade),
          arquivo: doc ? doc.arquivo : null,
          validade: doc ? mapa.soData(doc.validade) : null,
          observacao: doc ? doc.observacao : null,
          enviadoEm: doc ? doc.enviado_em : null,
          conferidoEm: doc ? doc.conferido_em : null,
          status, rotulo
        };
      });

      return {
        id: j.id,
        nome: j.nome,
        reserva: db.bool(j.reserva),
        documentos: itens,
        pendentes: itens.filter((i) => i.status !== 'aprovado').length
      };
    });

    return ctx.ok({
      ok: true,
      time: time.id,
      resumo: { total, ok: aprovados, pendencias, completo: pendencias.length === 0 },
      jogadores: lista
    });
  });

  rotas.put('/api/times/:id/jogadores/:jogadorId/documentos/:tipo', async (ctx) => {
    const conta = ctx.exigirCompetidor();
    const time = timeDoDono(conta, ctx.params.id);
    const jogador = exigirJogador(time.id, ctx.params.jogadorId);

    /* Sem regras.exigirEdicaoLiberada() de propósito: a trava congela o ELENCO,
       e enviar documento não muda quem joga. Se travasse, um documento recusado
       depois do fechamento das inscrições não teria como ser corrigido e o time
       ficaria irregular sem saída. */

    const tipo = regras.TIPOS_DOCUMENTO[ctx.params.tipo];
    if (!tipo) {
      throw erro400(
        `Tipo de documento desconhecido. Use: ${Object.keys(regras.TIPOS_DOCUMENTO).join(', ')}.`
      );
    }

    const corpo = await ctx.corpo(CORPO_MAX_UPLOAD);
    const arquivo = texto(corpo.arquivo);
    if (!arquivo) throw erro400('Anexe o arquivo do documento.');

    let validade = null;
    if (tipo.temValidade) {
      validade = exigirData(texto(corpo.validade), 'A validade do documento');
      if (!validade) throw erro400(`${tipo.nome} exige a data de validade.`);
    }

    const existente = db.um(
      'SELECT * FROM documentos WHERE jogador_id = ? AND tipo = ?', jogador.id, tipo.id
    );

    const linha = mapa.paraLinhaDocumento({
      tipo: tipo.id,
      arquivo,
      validade,
      /* Reenvio volta para a fila de conferência e limpa o parecer anterior:
         um documento recusado não pode continuar recusado depois de corrigido. */
      status: 'enviado',
      observacao: null,
      enviadoEm: db.agora(),
      conferidoEm: null,
      conferidoPor: null
    }, {
      /* O esquema tem índice único em (jogador_id, tipo), então o id pode sair
         desse par — é a convenção que a semente já usa. */
      id: existente ? existente.id : `${jogador.id}-${tipo.id}`,
      jogadorId: jogador.id
    });

    db.transacao(() => {
      if (existente) atualizar('documentos', linha, existente.id);
      else inserir('documentos', linha);
      regras.registrar(ctx, 'documento', time.nome, 'enviou', `${jogador.nome} · ${tipo.nome}`);
    });

    return ctx.ok({ ok: true, documento: mapa.documento(linha) });
  });

  /**
   * Conferência do administrador.
   *
   * A permissão 'documentos:conferir' não está nas listas de gestor nem de
   * operação em auth.PERMISSOES, então hoje só o master confere. Incluí-la lá
   * libera o nível sem mexer nesta rota.
   */
  rotas.post('/api/documentos/:id/conferir', async (ctx) => {
    const conta = ctx.exigirAdmin('documentos:conferir');
    const corpo = await ctx.corpo();

    const status = texto(corpo.status);
    if (status !== 'aprovado' && status !== 'recusado') {
      throw erro400('Informe status "aprovado" ou "recusado".');
    }

    const doc = db.um('SELECT * FROM documentos WHERE id = ?', ctx.params.id);
    if (!doc) throw erro404('Documento não encontrado.');
    if (!doc.arquivo) throw erro409('Este documento ainda não foi enviado — não há o que conferir.');

    const observacao = texto(corpo.observacao);
    /* Recusa sem motivo obriga o responsável a adivinhar o que corrigir. */
    if (status === 'recusado' && !observacao) {
      throw erro400('Descreva na observação o motivo da recusa.');
    }

    const origem = db.um(
      `SELECT j.nome AS jogador, t.nome AS time
         FROM jogadores j JOIN times t ON t.id = j.time_id
        WHERE j.id = ?`, doc.jogador_id
    );

    db.transacao(() => {
      db.executar(
        `UPDATE documentos
            SET status = ?, observacao = ?, conferido_em = ?, conferido_por = ?
          WHERE id = ?`,
        status, observacao, db.agora(), conta.id, doc.id
      );
      regras.registrar(ctx, 'documento', origem ? origem.time : null,
        status === 'aprovado' ? 'aprovou' : 'recusou',
        `${origem ? origem.jogador : doc.jogador_id} · ${regras.TIPOS_DOCUMENTO[doc.tipo].nome}` +
        (observacao ? ` · ${observacao}` : ''));
    });

    return ctx.ok({
      ok: true,
      documento: mapa.documento(db.um('SELECT * FROM documentos WHERE id = ?', doc.id))
    });
  });
}

module.exports = { registrar };
