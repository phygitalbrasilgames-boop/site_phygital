/* ==========================================================================
   CHAMADOS — o canal que sobra depois da trava de edição

   Quando as inscrições encerram, toda alteração passa a exigir chamado. Ele
   nasce com protocolo, guarda a conversa inteira e avisa por e-mail a cada
   movimento — abertura, resposta e encerramento.
   ========================================================================== */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;

const mensagensDe = (protocolo) => db.todos(
  `SELECT * FROM chamado_mensagens
    WHERE chamado_id = (SELECT id FROM chamados WHERE protocolo = ?) ORDER BY id`,
  protocolo
);

describe('chamados', () => {
  let mestre;
  let operacao;
  let dono;
  let protocolo;

  before(() => {
    mestre = amb.comoMaster();
    operacao = amb.comoOperacao();
    dono = amb.novoCompetidor('Autor dos Chamados');
  });

  /* ------------------------------------------------------------------------
     ABERTURA
     ------------------------------------------------------------------------ */

  it('o chamado nasce aberto, com protocolo sequencial e mensagem de sistema', async () => {
    const anterior = db.valor(
      "SELECT protocolo FROM chamados WHERE protocolo LIKE '2026-%' ORDER BY protocolo DESC LIMIT 1"
    );
    const esperado = `2026-${String(Number(anterior.slice(5)) + 1).padStart(6, '0')}`;

    const r = await dono.cliente.post('/api/chamados', {
      assunto: 'Troca de escudo do time',
      mensagem: 'O escudo subiu cortado no cadastro.',
      campeonato: amb.SEMEADOS.campeonatoFutebol,
      categoria: 'tecnico'
    });

    assert.equal(r.status, 201);
    protocolo = r.corpo.chamado.protocolo;

    assert.equal(protocolo, esperado);
    assert.equal(r.corpo.chamado.status, 'aberto');
    assert.equal(r.corpo.chamado.mensagens.length, 2);
    assert.equal(r.corpo.chamado.mensagens[0].de, 'usuario');
    assert.equal(r.corpo.chamado.mensagens[1].de, 'sistema');
    assert.equal(
      r.corpo.chamado.mensagens[1].texto,
      `Chamado recebido — protocolo ${protocolo}. Status: Aberto.`
    );
  });

  it('a abertura avisa o autor e a organização, com o protocolo no assunto', () => {
    const doUsuario = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'chamado-aberto' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    const paraAdmin = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'adm-novo-chamado' ORDER BY data DESC, rowid DESC LIMIT 1"
    );

    assert.equal(doUsuario.assunto, `Chamado ${protocolo} registrado`);
    assert.ok(!doUsuario.corpo.includes('{{'));
    assert.ok(paraAdmin && paraAdmin.qtd >= 1);
    /* O gestor não atende chamado, então não recebe o alerta. */
    assert.ok(!paraAdmin.para.includes(amb.CONTAS.gestor.email));
  });

  it('a abertura valida assunto, mensagem e campeonato', async () => {
    const curto = await dono.cliente.post('/api/chamados', {
      assunto: 'oi', mensagem: 'texto suficiente para valer'
    });
    assert.equal(curto.status, 400);

    const semTexto = await dono.cliente.post('/api/chamados', {
      assunto: 'Assunto válido de teste', mensagem: ''
    });
    assert.equal(semTexto.status, 400);

    const campeonatoInventado = await dono.cliente.post('/api/chamados', {
      assunto: 'Assunto válido de teste', mensagem: 'mensagem ok', campeonato: 'nao-existe'
    });
    assert.equal(campeonatoInventado.status, 400);

    const timeAlheio = await dono.cliente.post('/api/chamados', {
      assunto: 'Assunto válido de teste', mensagem: 'mensagem ok',
      timeId: amb.SEMEADOS.timeFutebol
    });
    assert.equal(timeAlheio.status, 403);
  });

  /* ------------------------------------------------------------------------
     LEITURA
     ------------------------------------------------------------------------ */

  it('o competidor vê só os próprios chamados; o admin vê a fila inteira', async () => {
    const dele = await dono.cliente.get('/api/chamados');
    assert.equal(dele.status, 200);
    assert.equal(dele.corpo.chamados.length, 1);
    assert.equal(dele.corpo.chamados[0].protocolo, protocolo);

    const fila = await mestre.get('/api/chamados');
    assert.equal(fila.corpo.chamados.length,
      db.valor('SELECT COUNT(*) FROM chamados WHERE arquivado_em IS NULL'));

    /* Chamado de outra conta responde 404, não 403. */
    const alheio = await dono.cliente.get(`/api/chamados/${amb.SEMEADOS.chamadoDeOutro}`);
    assert.equal(alheio.status, 404);

    /* O gestor lê a fila, ainda que não possa responder. */
    const doGestor = await amb.comoGestor().get(`/api/chamados/${amb.SEMEADOS.chamadoDeOutro}`);
    assert.equal(doGestor.status, 200);

    const filtroTorto = await mestre.get('/api/chamados?status=xpto');
    assert.equal(filtroTorto.status, 400);
  });

  /* ------------------------------------------------------------------------
     CONVERSA
     ------------------------------------------------------------------------ */

  it('a resposta da organização muda o status e avisa por e-mail', async () => {
    const doUsuario = await dono.cliente.post(`/api/chamados/${protocolo}/mensagens`, {
      texto: 'Segue o print do erro.'
    });
    assert.equal(doUsuario.status, 201);
    assert.equal(doUsuario.corpo.chamado.status, 'aberto');

    const daOrg = await operacao.post(`/api/chamados/${protocolo}/mensagens`, {
      texto: 'Recebemos, vamos verificar e retornamos hoje.'
    });
    assert.equal(daOrg.status, 201);
    assert.equal(daOrg.corpo.chamado.status, 'respondido');

    const ultima = daOrg.corpo.chamado.mensagens.at(-1);
    assert.equal(ultima.de, 'org');
    assert.equal(ultima.autor, 'Organização Phygital');

    const email = amb.ultimoEmail();
    assert.equal(email.modelo_id, 'chamado-respondido');
    assert.ok(email.corpo.includes('Respondido'));

    /* A réplica do competidor devolve o chamado para andamento. */
    const replica = await dono.cliente.post(`/api/chamados/${protocolo}/mensagens`, {
      texto: 'Continua acontecendo.'
    });
    assert.equal(replica.corpo.chamado.status, 'andamento');
  });

  it('o competidor não muda o status do próprio chamado', async () => {
    const r = await dono.cliente.post(`/api/chamados/${protocolo}/status`, { status: 'encerrado' });
    assert.equal(r.status, 403);
    assert.equal(db.valor('SELECT status FROM chamados WHERE protocolo = ?', protocolo), 'andamento');
  });

  it('mudança comum de status não cria mensagem; encerrar e reabrir criam', async () => {
    const antes = mensagensDe(protocolo).length;

    const comum = await mestre.post(`/api/chamados/${protocolo}/status`, { status: 'aberto' });
    assert.equal(comum.status, 200);
    assert.equal(mensagensDe(protocolo).length, antes, 'mudança comum não fala com o usuário');

    const encerrado = await operacao.post(`/api/chamados/${protocolo}/status`, { status: 'encerrado' });
    assert.equal(encerrado.corpo.chamado.status, 'encerrado');
    assert.equal(
      encerrado.corpo.chamado.mensagens.at(-1).texto, 'Chamado encerrado pela organização.'
    );
    assert.equal(amb.ultimoEmail().modelo_id, 'chamado-encerrado');

    const reaberto = await mestre.post(`/api/chamados/${protocolo}/status`, { status: 'andamento' });
    assert.equal(reaberto.corpo.chamado.mensagens.at(-1).texto, 'Chamado reaberto pela organização.');
  });

  it('chamado encerrado não aceita mensagem nova', async () => {
    await mestre.post(`/api/chamados/${protocolo}/status`, { status: 'encerrado' });

    const r = await dono.cliente.post(`/api/chamados/${protocolo}/mensagens`, { texto: 'e agora?' });
    assert.equal(r.status, 409);

    /* O chamado semeado como encerrado se comporta igual. */
    const semeado = await amb.comoCompetidor().post(
      `/api/chamados/${amb.SEMEADOS.chamadoEncerrado}/mensagens`, { texto: 'reabrir?' }
    );
    assert.equal(semeado.status, 409);
  });

  /* ------------------------------------------------------------------------
     ARQUIVAMENTO
     ------------------------------------------------------------------------ */

  it('só o master arquiva, e o arquivado some para o competidor mas fica para o admin', async () => {
    assert.equal((await operacao.apagar(`/api/chamados/${protocolo}`)).status, 403);

    const arquivado = await mestre.apagar(`/api/chamados/${protocolo}`);
    assert.equal(arquivado.status, 200);
    assert.ok(arquivado.corpo.arquivadoEm);

    assert.equal((await mestre.apagar(`/api/chamados/${protocolo}`)).status, 409);

    /* A conversa não é apagada — o histórico é a prova do que foi combinado. */
    assert.ok(mensagensDe(protocolo).length > 0);

    const doDono = await dono.cliente.get('/api/chamados');
    assert.ok(!doDono.corpo.chamados.some((c) => c.protocolo === protocolo));
    assert.equal((await dono.cliente.get(`/api/chamados/${protocolo}`)).status, 404);
    assert.equal((await mestre.get(`/api/chamados/${protocolo}`)).status, 200);

    /* Arquivado congela: nem o master muda o status sem restaurar antes. */
    const status = await mestre.post(`/api/chamados/${protocolo}/status`, { status: 'aberto' });
    assert.equal(status.status, 409);
  });

  it('protocolo inexistente devolve 404 e método errado devolve 405', async () => {
    assert.equal((await mestre.get('/api/chamados/9999-999999')).status, 404);
    assert.equal((await mestre.put(`/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}`, {})).status, 405);
  });

  it('a auditoria guarda a categoria informada na abertura', () => {
    const linha = db.um(
      "SELECT * FROM auditoria WHERE area = 'chamados' AND detalhe LIKE '%categoria: tecnico%' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(linha, 'a categoria do chamado precisa aparecer na trilha');
  });
});
