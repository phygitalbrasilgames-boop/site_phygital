/* ==========================================================================
   PHYGITAL BRASIL — INSCRIÇÕES

   O caminho que o briefing descreve: o competidor inscreve um time, a inscrição
   nasce na Lista de Inscritos ('triagem') e só o administrador a move para a
   Lista Oficial ou para a Lista de Espera. Cada transição avisa o responsável
   por e-mail.

   O ponto delicado é o primeiro e-mail: ele confirma o RECEBIMENTO e não a
   vaga. O texto está no modelo 'inscricao-confirmada' e é o único lugar onde
   essa frase existe — não repita a mensagem aqui.

   Nada aqui confia no front-end: dono do time, prazo, modalidade e elenco são
   conferidos de novo no servidor, dentro de uma transação, porque o painel do
   competidor roda no navegador do usuário.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const mapa = require('../mapa');
const regras = require('../regras');
const correio = require('../email');
const { erro400, erro403, erro404, erro409 } = require('../http');

/* Rótulos das listas, iguais aos de admin/campeonato-gerenciar.html, para que o
   histórico do administrador leia igual venha da tela ou da API. */
const NOME_DA_LISTA = {
  triagem: 'Lista de Inscritos',
  oficial: 'Lista Oficial',
  espera: 'Lista de Espera',
  cancelada: 'Cancelada'
};

/* --------------------------------------------------------------------------
   GRAVAÇÃO

   As colunas saem sempre de mapa.paraLinhaInscricao: nome de tabela e de coluna
   nunca vêm da requisição, só os valores — e esses viajam como parâmetro.
   -------------------------------------------------------------------------- */

function inserirInscricao(linha) {
  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO inscricoes (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );
}

function atualizarInscricao(id, linha) {
  const colunas = Object.keys(linha).filter((c) => c !== 'id');
  db.executar(
    `UPDATE inscricoes SET ${colunas.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
    ...colunas.map((c) => linha[c]), id
  );
}

/* --------------------------------------------------------------------------
   CONTAGENS

   O campeonato não guarda contador de inscritos: os números saem da tabela de
   inscrições toda vez que alguém pergunta (é o mesmo cálculo de
   rotas/bootstrap.js). "Recalcular" depois de uma mudança de status é refazer
   esta consulta e devolvê-la — não existe coluna para atualizar.
   -------------------------------------------------------------------------- */

function contagens(campeonatoId) {
  const l = db.um(
    `SELECT SUM(CASE WHEN status <> 'cancelada' THEN 1 ELSE 0 END) AS inscritos,
            SUM(CASE WHEN status =  'oficial'   THEN 1 ELSE 0 END) AS oficial,
            SUM(CASE WHEN status =  'espera'    THEN 1 ELSE 0 END) AS espera,
            SUM(CASE WHEN status =  'triagem'   THEN 1 ELSE 0 END) AS triagem,
            SUM(CASE WHEN status =  'cancelada' THEN 1 ELSE 0 END) AS canceladas
       FROM inscricoes WHERE campeonato_id = ?`,
    campeonatoId
  );

  return {
    inscritos: (l && l.inscritos) || 0,
    oficial: (l && l.oficial) || 0,
    espera: (l && l.espera) || 0,
    triagem: (l && l.triagem) || 0,
    canceladas: (l && l.canceladas) || 0
  };
}

/* --------------------------------------------------------------------------
   E-MAIL

   Todo envio passa por ../email.enviar() — o caminho único que o briefing
   exige. Aqui só se monta o CONTEXTO das variáveis; o texto vem de
   modelos_email, para o administrador poder editá-lo sem tocar em código.

   enviar() não lança: uma falha de e-mail vira linha com status 'falhou' e não
   desfaz a inscrição, que é o que essas chamadas estão penduradas dentro.
   -------------------------------------------------------------------------- */

/** Valores dos {{...}} documentados em mapa.VARIAVEIS_EMAIL, resolvidos por caminho. */
function contextoEmail({ conta, time, campeonato, inscricao, numeros }) {
  const status = regras.STATUS_INSCRICAO[inscricao.status];

  return {
    usuario: { nome: conta.nome, email: conta.email, telefone: conta.telefone },
    time: {
      nome: time.nome,
      modalidade: regras.modalidade(time.modalidade).curto,
      jogadores: db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ?', time.id) || 0
    },
    campeonato: {
      nome: campeonato.nome,
      data: mapa.soData(campeonato.data),
      local: campeonato.local,
      encerramento: mapa.soData(campeonato.encerramento_inscricoes),
      vagas: campeonato.vagas,
      inscritos: numeros.inscritos,
      oficial: numeros.oficial,
      espera: numeros.espera
    },
    inscricao: {
      protocolo: inscricao.protocolo,
      status: status ? status.rotulo : inscricao.status
    }
  };
}

/** Avisa o responsável pelo time — no dance, o próprio atleta: é a mesma conta. */
function avisarResponsavel(modeloId, dados) {
  return correio.enviar({
    modeloId,
    para: dados.conta.email,
    destino: dados.campeonato.nome,
    contexto: contextoEmail(dados),
    qtd: 1
  });
}

/** Alerta interno: vai para todos os administradores em atividade. */
function avisarAdministracao(modeloId, dados) {
  const admins = db.todos(
    `SELECT email FROM contas
      WHERE papel = 'admin' AND arquivado_em IS NULL AND email IS NOT NULL
      ORDER BY email`
  ).map((c) => c.email);
  if (!admins.length) return null;

  return correio.enviar({
    modeloId,
    para: admins,
    destino: 'Administradores',
    contexto: contextoEmail(dados)
  });
}

/**
 * Cancelamento é a única transição sem modelo na semente. Como o briefing manda
 * avisar em TODAS, o texto vai aqui mesmo, com {{...}} para que enviar() escape
 * os valores — nome de time é digitado pelo usuário e não pode entrar cru no
 * HTML do e-mail.
 */
function avisarCancelamento(dados, motivo) {
  return correio.enviar({
    para: dados.conta.email,
    destino: dados.campeonato.nome,
    assunto: 'Inscrição cancelada — {{campeonato.nome}}',
    corpo: '<p>Olá, {{usuario.nome}}.</p>'
      + '<p>A inscrição do time <b>{{time.nome}}</b> em <b>{{campeonato.nome}}</b>'
      + ' (protocolo <b>{{inscricao.protocolo}}</b>) foi cancelada.</p>'
      + (motivo ? '<p>Motivo: {{cancelamento.motivo}}</p>' : ''),
    contexto: { ...contextoEmail(dados), cancelamento: { motivo } },
    qtd: 1
  });
}

/* --------------------------------------------------------------------------
   LEITURA
   -------------------------------------------------------------------------- */

/**
 * Traz a inscrição com o time, o campeonato e a conta responsável — é o
 * conjunto que toda escrita precisa para decidir permissão e montar o e-mail.
 */
function carregar(id) {
  const inscricao = db.um('SELECT * FROM inscricoes WHERE id = ?', id);
  if (!inscricao) throw erro404('Inscrição não encontrada.');

  const time = db.um('SELECT * FROM times WHERE id = ?', inscricao.time_id);
  const campeonato = db.um('SELECT * FROM campeonatos WHERE id = ?', inscricao.campeonato_id);
  const conta = time ? db.um('SELECT * FROM contas WHERE id = ?', time.conta_id) : null;

  /* As chaves estrangeiras são ON DELETE CASCADE, então a ausência de time ou
     campeonato aqui indicaria banco inconsistente, não caso de uso. */
  if (!time || !campeonato || !conta) {
    throw erro404('A inscrição perdeu o vínculo com o time ou com o campeonato.');
  }

  return { inscricao, time, campeonato, conta };
}

/** Acrescenta ao payload padrão os nomes que as telas de lista exibem. */
function comNomes(linha) {
  return {
    ...mapa.inscricao(linha),
    timeNome: linha.time_nome,
    modalidade: linha.time_modalidade,
    campeonatoNome: linha.campeonato_nome
  };
}

/* --------------------------------------------------------------------------
   VALIDAÇÃO DO ELENCO

   Duas checagens do briefing: o tamanho do elenco (mínimo, máximo e reservas da
   modalidade) e os campos obrigatórios de cada atleta — no shooter, Steam64 e
   perfil Faceit.
   -------------------------------------------------------------------------- */

function conferirElenco(time) {
  const resultado = regras.validarElencoDoTime(time.id);
  const erros = [...resultado.erros];

  const jogadores = db.todos(
    'SELECT * FROM jogadores WHERE time_id = ? ORDER BY reserva, ordem, id', time.id
  );
  for (const jogador of jogadores) {
    erros.push(...regras.validarJogador(time.modalidade, jogador).erros);
  }

  return { valido: erros.length === 0, erros };
}

/* --------------------------------------------------------------------------
   ROTAS
   -------------------------------------------------------------------------- */

function registrar(rotas) {
  /* ------------------------------------------------------------------------
     GET /api/inscricoes
     Competidor vê as próprias; administrador vê todas. Os filtros valem para
     os dois — no competidor eles apenas estreitam o que já é dele.
     ------------------------------------------------------------------------ */
  rotas.get('/api/inscricoes', async (ctx) => {
    const conta = ctx.exigirLogin();

    const onde = [];
    const params = [];

    if (conta.papel === 'admin') {
      ctx.exigirAdmin('inscricoes:ler');
    } else {
      onde.push('t.conta_id = ?');
      params.push(conta.id);
    }

    const campeonato = ctx.query.get('campeonato');
    if (campeonato) {
      onde.push('i.campeonato_id = ?');
      params.push(campeonato);
    }

    const status = ctx.query.get('status');
    if (status) {
      if (!regras.STATUS_INSCRICAO[status]) {
        throw erro400(`Status inválido: ${status}. Use triagem, oficial, espera ou cancelada.`);
      }
      onde.push('i.status = ?');
      params.push(status);
    }

    const linhas = db.todos(
      `SELECT i.*, t.nome AS time_nome, t.modalidade AS time_modalidade,
              c.nome AS campeonato_nome
         FROM inscricoes i
         JOIN times t       ON t.id = i.time_id
         JOIN campeonatos c ON c.id = i.campeonato_id
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
        ORDER BY i.data DESC, i.id`,
      ...params
    );

    ctx.ok({
      ok: true,
      total: linhas.length,
      inscricoes: linhas.map(comNomes),
      ...(campeonato ? { contagens: contagens(campeonato) } : {})
    });
  });

  /* ------------------------------------------------------------------------
     POST /api/inscricoes
     ------------------------------------------------------------------------ */
  rotas.post('/api/inscricoes', async (ctx) => {
    const conta = ctx.exigirCompetidor();
    const corpo = await ctx.corpo();

    const campeonatoId = String(corpo.campeonatoId || '').trim();
    const timeId = String(corpo.timeId || '').trim();
    if (!campeonatoId || !timeId) {
      throw erro400('Informe o campeonato (campeonatoId) e o time (timeId).');
    }

    /* Tudo numa transação: sem ela, duas requisições simultâneas podem tirar o
       mesmo número de protocolo antes de qualquer INSERT acontecer. */
    const resposta = db.transacao(() => {
      const time = db.um('SELECT * FROM times WHERE id = ? AND arquivado_em IS NULL', timeId);
      if (!time) throw erro404('Time não encontrado.');
      if (time.conta_id !== conta.id) throw erro403('Este time pertence a outra conta.');

      const campeonato = db.um(
        'SELECT * FROM campeonatos WHERE id = ? AND arquivado_em IS NULL', campeonatoId
      );
      if (!campeonato) throw erro404('Campeonato não encontrado.');

      const aberta = regras.inscricaoAberta(campeonato);
      if (!aberta.aberta) throw erro409(aberta.motivo);

      if (time.modalidade !== campeonato.modalidade) {
        throw erro409(
          `O time ${time.nome} é de ${regras.modalidade(time.modalidade).curto} e `
          + `${campeonato.nome} é de ${regras.modalidade(campeonato.modalidade).curto}.`
        );
      }

      /* O índice único é (campeonato_id, time_id) e vale também para a linha
         cancelada. Reinscrever é reaproveitar essa linha com protocolo novo —
         senão cancelar uma vez barraria o time para sempre. */
      const anterior = db.um(
        'SELECT * FROM inscricoes WHERE campeonato_id = ? AND time_id = ?', campeonatoId, timeId
      );
      if (anterior && anterior.status !== 'cancelada') {
        throw erro409(
          `${time.nome} já está inscrito em ${campeonato.nome} (protocolo ${anterior.protocolo}).`,
          { inscricao: anterior.id, protocolo: anterior.protocolo, status: anterior.status }
        );
      }

      const elenco = conferirElenco(time);
      if (!elenco.valido) {
        throw erro409(
          `O elenco de ${time.nome} não atende às regras de ${regras.modalidade(time.modalidade).curto}.`,
          { erros: elenco.erros }
        );
      }

      const protocolo = regras.proximoProtocolo('inscricoes');
      const linha = mapa.paraLinhaInscricao(
        { campeonato: campeonatoId, time: timeId, protocolo, status: 'triagem' },
        anterior
          ? { id: anterior.id, criadoEm: anterior.criado_em }
          : { id: crypto.randomUUID() }
      );

      if (anterior) atualizarInscricao(anterior.id, linha);
      else inserirInscricao(linha);

      const inscricao = db.um('SELECT * FROM inscricoes WHERE id = ?', linha.id);
      const numeros = contagens(campeonatoId);

      regras.registrar(
        ctx, 'inscricao', time.nome,
        anterior ? 'reinscreveu o time' : 'inscreveu o time',
        `${campeonato.nome} · protocolo ${protocolo}`
      );

      const dados = { conta, time, campeonato, inscricao, numeros };
      /* O modelo diz, com todas as letras, que confirma o recebimento e NÃO
         garante vaga — é a exigência explícita do briefing. */
      avisarResponsavel('inscricao-confirmada', dados);
      avisarAdministracao('adm-nova-inscricao', dados);

      return {
        ok: true,
        inscricao: mapa.inscricao(inscricao),
        protocolo,
        contagens: numeros
      };
    });

    ctx.ok(resposta);
  });

  /* ------------------------------------------------------------------------
     POST /api/inscricoes/:id/status
     Triagem para lista oficial ou de espera — a decisão é do administrador.
     ------------------------------------------------------------------------ */
  rotas.post('/api/inscricoes/:id/status', async (ctx) => {
    /* Mover listas é escrita: gestor e operação só leem inscrição. */
    ctx.exigirAdmin('inscricoes:escrever');
    const corpo = await ctx.corpo();

    const novo = String(corpo.status || '').trim();
    if (!regras.STATUS_INSCRICAO[novo]) {
      throw erro400(`Status inválido: ${novo || '(vazio)'}. Use triagem, oficial, espera ou cancelada.`);
    }

    const observacao = String(corpo.observacao || '').trim();
    if (novo === 'cancelada' && !observacao) {
      throw erro400('Explique em "observacao" o motivo do cancelamento.');
    }

    const resposta = db.transacao(() => {
      const { inscricao, time, campeonato, conta } = carregar(ctx.params.id);
      const anterior = inscricao.status;

      if (anterior === novo) {
        return {
          ok: true,
          alterado: false,
          inscricao: mapa.inscricao(inscricao),
          contagens: contagens(campeonato.id)
        };
      }

      /* vagas = 0 é campeonato ainda sem lotação definida (o padrão da coluna),
         não campeonato lotado: nesse caso não há teto a impor. */
      const vagas = Number(campeonato.vagas) || 0;
      const oficiais = db.valor(
        `SELECT COUNT(*) FROM inscricoes
          WHERE campeonato_id = ? AND status = 'oficial' AND id <> ?`,
        campeonato.id, inscricao.id
      ) || 0;

      if (novo === 'oficial' && vagas > 0 && oficiais >= vagas) {
        throw erro409(
          `A Lista Oficial de ${campeonato.nome} já ocupa as ${vagas} vagas. `
          + 'Mova algum time para a Lista de Espera antes de confirmar outro.',
          { vagas, oficial: oficiais }
        );
      }

      db.executar(
        'UPDATE inscricoes SET status = ?, observacao = ?, atualizado_em = ? WHERE id = ?',
        novo, observacao || inscricao.observacao || null, db.agora(), inscricao.id
      );

      const atual = db.um('SELECT * FROM inscricoes WHERE id = ?', inscricao.id);
      const numeros = contagens(campeonato.id);

      regras.registrar(
        ctx, 'inscricao', time.nome,
        `moveu para ${NOME_DA_LISTA[novo]}`,
        `${campeonato.nome} · vinha de ${NOME_DA_LISTA[anterior] || anterior}`
        + (observacao ? ` · ${observacao}` : '')
      );

      const dados = { conta, time, campeonato, inscricao: atual, numeros };

      /* Vale para qualquer origem, não só triagem: promover da lista de espera
         também é uma transição e o briefing manda avisar em todas. */
      if (novo === 'oficial') avisarResponsavel('lista-oficial', dados);
      if (novo === 'espera') avisarResponsavel('lista-espera', dados);
      if (novo === 'cancelada') avisarCancelamento(dados, observacao);

      /* Só no momento exato em que a lista fecha — repetir o alerta a cada nova
         confirmação viraria ruído na caixa do administrador. */
      if (novo === 'oficial' && vagas > 0 && numeros.oficial === vagas) {
        avisarAdministracao('adm-vagas-preenchidas', dados);
      }

      return {
        ok: true,
        alterado: true,
        de: anterior,
        para: novo,
        inscricao: mapa.inscricao(atual),
        contagens: numeros
      };
    });

    ctx.ok(resposta);
  });

  /* ------------------------------------------------------------------------
     DELETE /api/inscricoes/:id
     Cancelamento pelo próprio responsável, enquanto dá tempo.
     ------------------------------------------------------------------------ */
  rotas.delete('/api/inscricoes/:id', async (ctx) => {
    const conta = ctx.exigirCompetidor();
    const corpo = await ctx.corpo();
    const motivo = String(corpo.observacao || corpo.motivo || '').trim();

    const resposta = db.transacao(() => {
      const alvo = carregar(ctx.params.id);
      const { inscricao, time, campeonato } = alvo;

      if (time.conta_id !== conta.id) throw erro403('Esta inscrição pertence a outra conta.');

      if (inscricao.status === 'cancelada') {
        return {
          ok: true,
          alterado: false,
          inscricao: mapa.inscricao(inscricao),
          contagens: contagens(campeonato.id)
        };
      }

      /* De propósito não usa regras.exigirEdicaoLiberada: aquela trava olha
         TODOS os campeonatos do time, e o prazo que importa para cancelar é o
         deste campeonato. */
      const aberta = regras.inscricaoAberta(campeonato);
      if (!aberta.aberta) {
        throw erro409(
          `${aberta.motivo} Para cancelar a inscrição de ${time.nome} agora, abra um chamado `
          + 'e a organização avalia o pedido.',
          { exigeChamado: true, campeonato: campeonato.id, protocolo: inscricao.protocolo }
        );
      }

      const observacao = `Cancelada pelo responsável${motivo ? ` · ${motivo}` : ''}`;

      db.executar(
        'UPDATE inscricoes SET status = ?, observacao = ?, atualizado_em = ? WHERE id = ?',
        'cancelada', observacao, db.agora(), inscricao.id
      );

      const atual = db.um('SELECT * FROM inscricoes WHERE id = ?', inscricao.id);
      const numeros = contagens(campeonato.id);

      regras.registrar(
        ctx, 'inscricao', time.nome, 'cancelou a inscrição',
        `${campeonato.nome} · protocolo ${inscricao.protocolo}`
        + (motivo ? ` · ${motivo}` : '')
      );

      avisarCancelamento({ ...alvo, inscricao: atual, numeros }, motivo);

      return {
        ok: true,
        alterado: true,
        inscricao: mapa.inscricao(atual),
        contagens: numeros
      };
    });

    ctx.ok(resposta);
  });
}

module.exports = { registrar };
