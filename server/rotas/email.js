/* ==========================================================================
   PHYGITAL BRASIL — ROTAS DE E-MAIL

   Administração do caminho único de e-mail: modelos, configuração de SMTP,
   histórico, prévia e disparo em massa. Todo envio sai por ../email.js —
   nenhuma rota daqui monta e-mail por conta própria.

   Níveis (auth.PERMISSOES):
     · leitura (modelos, variáveis, SMTP, histórico) → qualquer admin
     · disparo em massa                              → permissão 'email:enviar'
       (master e gestor)
     · edição de modelo, SMTP e teste                → só master

   "Só master" é expresso pedindo uma permissão que nenhum outro nível tem:
   master é o único com '*', então exigirAdmin('email:configurar') já barra
   gestor e operação sem precisar de checagem paralela de nível.
   ========================================================================== */
'use strict';

const db = require('../db');
const mapa = require('../mapa');
const regras = require('../regras');
const email = require('../email');
const { erro400, erro404 } = require('../http');

/* Teto do histórico devolvido de uma vez. */
const LIMITE_PADRAO = 50;
const LIMITE_MAX = 500;

/* Quantos destinatários voltam na resposta do disparo. A contagem é sempre
   exata; a lista é amostra, para a tela confirmar quem recebe sem despejar
   centenas de endereços numa resposta HTTP. */
const AMOSTRA_MAX = 50;

/* --------------------------------------------------------------------------
   APOIO
   -------------------------------------------------------------------------- */

/** Chaves de variável documentadas, achatadas a partir de mapa.VARIAVEIS_EMAIL. */
function variaveisConhecidas() {
  const saida = new Set();
  mapa.VARIAVEIS_EMAIL.forEach((g) => g.itens.forEach((i) => saida.add(i.chave)));
  return saida;
}

/**
 * Anexo entra como METADADO, nunca como conteúdo: o corpo da requisição tem
 * teto de 2 MB e guardar arquivo em base64 no banco estouraria o histórico.
 * O conteúdo real será tratado pelo conector de SMTP quando existir.
 */
function limparAnexos(bruto) {
  if (!Array.isArray(bruto)) return [];
  return bruto.slice(0, 10).map((a) => ({
    nome: String((a && a.nome) || 'arquivo').slice(0, 160),
    tipo: String((a && a.tipo) || '').slice(0, 80),
    tamanho: Number(a && a.tamanho) || 0
  }));
}

const texto = (v) => String(v === undefined || v === null ? '' : v).trim();

/* --------------------------------------------------------------------------
   DESTINATÁRIOS

   Regra do briefing: o disparo entrega APENAS ao usuário responsável do time.
   Na dança não há time no sentido usual — o cadastro é de um atleta só, então
   o endereço do próprio atleta tem prioridade sobre o da conta responsável.

   Inscrição cancelada não recebe comunicado de campeonato.
   -------------------------------------------------------------------------- */

const SQL_DESTINATARIOS = `
  SELECT i.protocolo, i.status,
         c.id AS campeonato_id, c.nome AS campeonato, c.modalidade,
         t.id AS time_id, t.nome AS time_nome,
         ct.id AS conta_id, ct.nome AS responsavel, ct.email AS conta_email,
         ct.telefone AS conta_telefone,
         ja.nome AS atleta_nome, ja.email AS atleta_email,
         (SELECT COUNT(*) FROM jogadores j2 WHERE j2.time_id = t.id) AS jogadores
    FROM inscricoes i
    JOIN times t        ON t.id = i.time_id
    JOIN campeonatos c  ON c.id = i.campeonato_id
    JOIN contas ct      ON ct.id = t.conta_id
    /* Atleta do cadastro: o primeiro titular com e-mail. Sai por JOIN em vez de
       duas subconsultas para nome e e-mail virem garantidamente da mesma linha. */
    LEFT JOIN jogadores ja ON ja.id = (
      SELECT j.id FROM jogadores j
       WHERE j.time_id = t.id AND j.reserva = 0
         AND j.email IS NOT NULL AND trim(j.email) <> ''
       ORDER BY j.ordem, j.id LIMIT 1)
   WHERE i.status <> 'cancelada'
     AND ct.arquivado_em IS NULL
     AND t.arquivado_em IS NULL
     AND c.arquivado_em IS NULL`;

/**
 * Resolve o público do disparo.
 * @param alvo 'todos' | 'abertos' | id de campeonato (aceita o prefixo 'camp:'
 *             que o seletor da tela usa)
 */
function resolverDestinatarios(alvo) {
  const escolha = texto(alvo).replace(/^camp:/, '') || 'todos';

  let sql = SQL_DESTINATARIOS;
  const params = [];
  let rotulo;

  if (escolha === 'todos') {
    rotulo = 'Todos os campeonatos';
  } else if (escolha === 'abertos') {
    sql += " AND c.status = 'inscricoes'";
    rotulo = 'Campeonatos com inscrições abertas';
  } else {
    const camp = db.um('SELECT * FROM campeonatos WHERE id = ?', escolha);
    if (!camp) throw erro404(`Campeonato não encontrado: ${escolha}.`);
    sql += ' AND c.id = ?';
    params.push(escolha);
    rotulo = camp.nome;
  }

  const linhas = db.todos(`${sql} ORDER BY c.nome, t.nome`, ...params);

  /* Uma pessoa responsável por dois times não recebe duas cópias do mesmo
     comunicado. A contagem de inscrições fica separada porque é ela que a tela
     mostra ao lado do seletor. */
  const porEndereco = new Map();

  for (const l of linhas) {
    const endereco = (l.modalidade === 'dance' && l.atleta_email)
      ? l.atleta_email
      : l.conta_email;
    if (!endereco) continue;

    const chave = String(endereco).toLowerCase();
    if (porEndereco.has(chave)) continue;

    porEndereco.set(chave, {
      email: endereco,
      /* Na dança quem recebe é o atleta, mas o nome do responsável segue
         valendo como saudação quando o atleta não tem nome próprio na conta. */
      nome: l.responsavel,
      contaId: l.conta_id,
      telefone: l.conta_telefone,
      time: l.time_nome,
      modalidade: l.modalidade,
      jogadores: l.jogadores,
      campeonatoId: l.campeonato_id,
      campeonato: l.campeonato,
      protocolo: l.protocolo,
      statusInscricao: l.status
    });
  }

  return { rotulo, escolha, destinatarios: [...porEndereco.values()], inscricoes: linhas.length };
}

/** Contexto de variáveis a partir de um destinatário resolvido. */
function contextoDe(d) {
  if (!d) return {};

  const camp = d.campeonatoId
    ? db.um('SELECT * FROM campeonatos WHERE id = ?', d.campeonatoId)
    : null;

  return {
    usuario: { nome: d.nome, email: d.email, telefone: d.telefone },
    time: { nome: d.time, modalidade: d.modalidade, jogadores: d.jogadores },
    campeonato: camp ? {
      nome: camp.nome,
      data: camp.data,
      local: camp.local,
      encerramento: camp.encerramento_inscricoes,
      vagas: camp.vagas
    } : {},
    inscricao: { protocolo: d.protocolo, status: d.statusInscricao }
  };
}

/* --------------------------------------------------------------------------
   ROTAS
   -------------------------------------------------------------------------- */

function registrar(rotas) {

  /* ---- Modelos ---------------------------------------------------------- */

  rotas.get('/api/email/modelos', async (ctx) => {
    ctx.exigirAdmin();

    const linhas = db.todos(
      "SELECT * FROM modelos_email ORDER BY (para = 'admin'), grupo, nome"
    );

    ctx.ok({
      ok: true,
      modelos: mapa.lista(linhas, mapa.modeloEmail).map((m) => ({
        ...m,
        obrigatorias: email.VARIAVEIS_OBRIGATORIAS[m.id] || []
      }))
    });
  });

  rotas.put('/api/email/modelos/:id', async (ctx) => {
    ctx.exigirAdmin('email:configurar');

    const atualLinha = db.um('SELECT * FROM modelos_email WHERE id = ?', ctx.params.id);
    if (!atualLinha) throw erro404(`Modelo de e-mail não encontrado: ${ctx.params.id}.`);

    const corpoReq = await ctx.corpo();
    const atual = mapa.modeloEmail(atualLinha);

    /* Atualização parcial: mescla com o que já está gravado antes de montar a
       linha completa, senão os campos ausentes seriam apagados. */
    const mesclado = {
      ...atual,
      ...(corpoReq.nome !== undefined ? { nome: texto(corpoReq.nome) } : {}),
      ...(corpoReq.grupo !== undefined ? { grupo: texto(corpoReq.grupo) } : {}),
      ...(corpoReq.quando !== undefined ? { quando: texto(corpoReq.quando) } : {}),
      ...(corpoReq.assunto !== undefined ? { assunto: texto(corpoReq.assunto) } : {}),
      ...(corpoReq.corpo !== undefined ? { corpo: String(corpoReq.corpo || '') } : {}),
      ...(corpoReq.ativo !== undefined ? { ativo: Boolean(corpoReq.ativo) } : {}),
      /* id e destinatário do modelo não mudam: são o contrato de quem dispara. */
      id: atual.id,
      para: atual.para
    };

    if (!mesclado.assunto) throw erro400('O assunto do modelo não pode ficar vazio.');
    if (!texto(mesclado.corpo)) throw erro400('O corpo do modelo não pode ficar vazio.');

    /* Variáveis que o modelo não pode perder. */
    const obrigatorias = email.VARIAVEIS_OBRIGATORIAS[atual.id] || [];
    const juntos = `${mesclado.assunto} ${mesclado.corpo}`;
    const faltando = obrigatorias.filter((v) => !juntos.includes(v));

    if (faltando.length) {
      throw erro400(
        `O modelo "${atual.nome}" precisa manter ${faltando.join(', ')} no assunto ou no corpo.`,
        { faltando }
      );
    }

    /* Avisos não bloqueiam: apontam o que provavelmente é engano. */
    const avisos = [];
    const conhecidas = variaveisConhecidas();
    const desconhecidas = email.variaveisDe(juntos).filter((v) => !conhecidas.has(v));

    if (desconhecidas.length) {
      avisos.push(
        `Variável sem valor conhecido: ${desconhecidas.join(', ')}. No envio ela sai como texto vazio.`
      );
    }

    /* Exigência do briefing: a primeira mensagem confirma o RECEBIMENTO e não
       garante vaga. Não dá para validar a prosa, mas dá para avisar. */
    if (atual.id === 'inscricao-confirmada'
        && !mesclado.corpo.toLowerCase().includes(email.RESSALVA_INSCRICAO)) {
      avisos.push(
        'O texto perdeu a ressalva de que a inscrição confirma o recebimento e não garante vaga.'
      );
    }

    const linha = mapa.paraLinhaModeloEmail(mesclado);
    db.executar(
      `UPDATE modelos_email
          SET grupo = ?, nome = ?, quando = ?, para = ?, assunto = ?, corpo = ?,
              ativo = ?, atualizado_em = ?
        WHERE id = ?`,
      linha.grupo, linha.nome, linha.quando, linha.para, linha.assunto,
      linha.corpo, linha.ativo, linha.atualizado_em, linha.id
    );

    regras.registrar(ctx, 'email', linha.nome, 'editou modelo de e-mail', `Modelo ${linha.id}`);

    ctx.ok({
      ok: true,
      modelo: mapa.modeloEmail(db.um('SELECT * FROM modelos_email WHERE id = ?', linha.id)),
      avisos
    });
  });

  /* ---- Variáveis -------------------------------------------------------- */

  rotas.get('/api/email/variaveis', async (ctx) => {
    ctx.exigirAdmin();
    ctx.ok({ ok: true, variaveis: mapa.VARIAVEIS_EMAIL, obrigatorias: email.VARIAVEIS_OBRIGATORIAS });
  });

  /* ---- SMTP ------------------------------------------------------------- */

  rotas.get('/api/email/smtp', async (ctx) => {
    ctx.exigirAdmin();

    /* mapa.smtp() não tem campo de senha e a tabela não tem coluna para ela:
       a senha vive só em PHYGITAL_SMTP_SENHA. Devolvemos apenas se ela existe,
       porque a tela precisa dizer se a configuração está completa. */
    ctx.ok({
      ok: true,
      smtp: mapa.smtp(db.um('SELECT * FROM smtp WHERE id = 1')),
      senhaConfigurada: Boolean(process.env.PHYGITAL_SMTP_SENHA),
      modo: process.env.PHYGITAL_MODO || 'dev',
      /* Deixa explícito na resposta que, fora de produção, nada sai. */
      envioReal: email.statusDeEnvio() === 'fila'
    });
  });

  rotas.put('/api/email/smtp', async (ctx) => {
    ctx.exigirAdmin('email:configurar');

    const corpoReq = await ctx.corpo();

    /* Senha por API viraria senha no banco, no log e no histórico de request.
       Ela entra por ambiente e só por ambiente. */
    if (corpoReq.senha !== undefined || corpoReq.password !== undefined) {
      throw erro400(
        'A senha do SMTP não é gravada pelo painel: defina PHYGITAL_SMTP_SENHA no ambiente do servidor.'
      );
    }

    const atual = mapa.smtp(db.um('SELECT * FROM smtp WHERE id = 1'));
    const linha = mapa.paraLinhaSmtp({ ...atual, ...corpoReq });

    const colunas = Object.keys(linha);
    db.transacao(() => {
      /* Linha única (o esquema trava id = 1): trocar inteira é mais simples e
         seguro do que montar UPDATE parcial. */
      db.executar('DELETE FROM smtp WHERE id = 1');
      db.executar(
        `INSERT INTO smtp (${colunas.map((c) => `"${c}"`).join(', ')})
         VALUES (${colunas.map(() => '?').join(', ')})`,
        ...colunas.map((c) => linha[c])
      );
    });

    regras.registrar(ctx, 'email', linha.servidor_saida || 'SMTP',
      'alterou configuração de e-mail', `Servidor de saída ${linha.servidor_saida || '—'}`);

    ctx.ok({
      ok: true,
      smtp: mapa.smtp(db.um('SELECT * FROM smtp WHERE id = 1')),
      senhaConfigurada: Boolean(process.env.PHYGITAL_SMTP_SENHA)
    });
  });

  /* ---- Teste ------------------------------------------------------------ */

  rotas.post('/api/email/testar', async (ctx) => {
    const conta = ctx.exigirAdmin('email:configurar');
    const corpoReq = await ctx.corpo();

    /* Sem destino informado, o teste vai para quem pediu o teste. */
    const para = texto(corpoReq.para) || conta.email;
    const cfg = db.um('SELECT * FROM smtp WHERE id = 1');

    const resultado = email.enviar({
      para,
      destino: 'Teste de configuração',
      assunto: 'Teste de configuração de e-mail — Phygital Brasil',
      corpo: '<p>Se você recebeu esta mensagem, a configuração de envio da Phygital Brasil'
        + ' está respondendo.</p><p>Servidor de saída: <b>{{smtp.servidor}}</b><br>'
        + 'Disparado por: {{usuario.nome}} em {{data}}.</p>',
      contexto: { usuario: { nome: conta.nome, email: conta.email } },
      qtd: 1
    });

    regras.registrar(ctx, 'email', para, 'enviou e-mail de teste',
      `Servidor ${cfg ? cfg.servidor_saida : '—'} · status ${resultado.status}`);

    ctx.ok({
      ok: resultado.ok,
      status: resultado.status,
      motivo: resultado.motivo,
      para: resultado.para,
      previa: resultado.html,
      /* Em desenvolvimento o e-mail é gravado, não entregue — a tela precisa
         dizer isso ao admin em vez de fingir sucesso. */
      simulado: resultado.status === 'simulado',
      registro: resultado.registro
    });
  });

  /* ---- Histórico -------------------------------------------------------- */

  rotas.get('/api/email/enviados', async (ctx) => {
    ctx.exigirAdmin();

    const pedido = Number(ctx.query.get('limite')) || LIMITE_PADRAO;
    const limite = Math.min(Math.max(pedido, 1), LIMITE_MAX);

    ctx.ok({
      ok: true,
      enviados: email.ultimos(limite),
      fila: email.fila().length,
      total: db.valor('SELECT COUNT(*) FROM emails_enviados') || 0
    });
  });

  /* ---- Prévia ----------------------------------------------------------- */

  rotas.post('/api/email/previa', async (ctx) => {
    ctx.exigirAdmin();

    const corpoReq = await ctx.corpo();
    const assunto = texto(corpoReq.assunto);
    const mensagem = String(corpoReq.corpo || '');

    if (!assunto) throw erro400('Escreva o assunto para gerar a prévia.');
    if (!texto(mensagem)) throw erro400('Escreva a mensagem para gerar a prévia.');

    /* A prévia usa um destinatário real do público escolhido como amostra —
       é assim que o admin vê como as variáveis ficam preenchidas de verdade.
       Sem público, cai no próprio admin. */
    let amostra = null;
    if (corpoReq.campeonatoId) {
      const alvo = resolverDestinatarios(corpoReq.campeonatoId);
      amostra = alvo.destinatarios[0] || null;
    }

    const contexto = amostra
      ? contextoDe(amostra)
      : { usuario: { nome: ctx.conta.nome, email: ctx.conta.email } };

    const ctxCompleto = email.contextoCompleto(contexto);
    const anexos = limparAnexos(corpoReq.anexos);

    ctx.ok({
      ok: true,
      assunto: email.limparAssunto(email.substituir(assunto, ctxCompleto, { html: false })),
      html: email.montarHtml({
        assunto: email.limparAssunto(email.substituir(assunto, ctxCompleto, { html: false })),
        corpo: email.substituir(mensagem, ctxCompleto),
        anexos
      }),
      amostra: amostra ? { nome: amostra.nome, time: amostra.time, campeonato: amostra.campeonato } : null
    });
  });

  /* ---- Disparo em massa ------------------------------------------------- */

  rotas.post('/api/email/disparar', async (ctx) => {
    ctx.exigirAdmin('email:enviar');

    const corpoReq = await ctx.corpo();
    const assunto = texto(corpoReq.assunto);
    const mensagem = String(corpoReq.corpo || '');

    if (!assunto) throw erro400('Informe o assunto do e-mail.');
    if (!texto(mensagem)) throw erro400('Escreva a mensagem do e-mail.');

    const anexos = limparAnexos(corpoReq.anexos);
    const alvo = resolverDestinatarios(corpoReq.campeonatoId || corpoReq.alvo || 'todos');

    if (!alvo.destinatarios.length) {
      throw erro400(
        `Nenhum destinatário em ${alvo.rotulo}: não há inscrição ativa com e-mail de responsável.`
      );
    }

    /* O histórico guarda UMA linha por disparo, com qtd = destinatários — é o
       modelo da coluna qtd e o que a tela de histórico mostra. As variáveis são
       resolvidas com o contexto do primeiro destinatário, para o registro
       guardar um exemplo legível do que foi enviado. Quando o conector SMTP
       real existir, é ele que refaz a substituição para CADA destinatário
       antes de entregar. */
    const resultado = email.enviar({
      para: alvo.destinatarios.map((d) => d.email),
      destino: alvo.rotulo,
      assunto,
      corpo: mensagem,
      contexto: contextoDe(alvo.destinatarios[0]),
      qtd: alvo.destinatarios.length,
      anexos
    });

    regras.registrar(ctx, 'email', assunto, 'disparou e-mail',
      `${alvo.destinatarios.length} destinatário(s) · ${alvo.rotulo} · status ${resultado.status}`);

    ctx.ok({
      ok: resultado.ok,
      status: resultado.status,
      motivo: resultado.motivo,
      destino: alvo.rotulo,
      destinatarios: alvo.destinatarios.length,
      /* Inscrições ativas do público: maior que `destinatarios` quando um
         mesmo responsável tem times em mais de um campeonato. */
      inscricoes: alvo.inscricoes,
      amostra: alvo.destinatarios.slice(0, AMOSTRA_MAX)
        .map((d) => ({ nome: d.nome, email: d.email, time: d.time, campeonato: d.campeonato })),
      assunto: resultado.assunto,
      previa: resultado.html,
      simulado: resultado.status === 'simulado',
      registro: resultado.registro
    });
  });
}

module.exports = { registrar, resolverDestinatarios, contextoDe };
