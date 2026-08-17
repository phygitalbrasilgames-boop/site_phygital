/* ==========================================================================
   INSCRIÇÕES — o ciclo Lista de Inscritos → Oficial / Espera

   O caminho do briefing: o competidor inscreve, a inscrição nasce em triagem,
   e só o administrador a move. Cada transição avisa o responsável, e o
   primeiro e-mail precisa dizer que confirma o RECEBIMENTO, não a vaga.

   As contagens não são coluna: saem da tabela de inscrições a cada pergunta.
   É por isso que quase toda asserção daqui compara a resposta da API com um
   SELECT feito na hora.
   ========================================================================== */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;

describe('inscrições', () => {
  let mestre;
  let dono;
  let aberto;          /* campeonato de futebol com 2 vagas, prazo aberto */
  let vencido;         /* campeonato publicado com o prazo já encerrado */
  let alfa;
  let beta;
  let gama;
  let curto;           /* time de elenco incompleto */

  before(async () => {
    mestre = amb.comoMaster();
    dono = amb.novoCompetidor('Responsável pelas Inscrições');

    aberto = await amb.novoCampeonato(mestre, {
      nome: 'Copa das Inscrições 2027', modalidade: 'futebol', vagas: 2
    });
    vencido = await amb.novoCampeonato(mestre, {
      nome: 'Copa do Prazo Encerrado 2026', modalidade: 'futebol', vagas: 8, prazo: 'vencido'
    });

    alfa = await amb.novoTime(dono.cliente, { modalidade: 'futebol', nome: 'Alfa FC', titulares: 6 });
    beta = await amb.novoTime(dono.cliente, { modalidade: 'futebol', nome: 'Beta FC', titulares: 6 });
    gama = await amb.novoTime(dono.cliente, { modalidade: 'futebol', nome: 'Gama FC', titulares: 6 });
    curto = await amb.novoTime(dono.cliente, { modalidade: 'futebol', nome: 'Curto FC', titulares: 2 });
  });

  /* ------------------------------------------------------------------------
     RECUSAS
     ------------------------------------------------------------------------ */

  it('elenco incompleto é recusado com 409 e a lista de erros', async () => {
    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: curto.id
    });

    assert.equal(r.status, 409);
    assert.ok(Array.isArray(r.corpo.erros) && r.corpo.erros.length > 0);
    assert.match(r.corpo.erros.join(' '), /no mínimo 6/);
    assert.equal(db.valor('SELECT COUNT(*) FROM inscricoes WHERE time_id = ?', curto.id), 0);
  });

  it('fora do prazo é recusado, mesmo com o campeonato ainda publicado', async () => {
    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: vencido.id, timeId: alfa.id
    });

    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /encerraram/i);
    assert.equal(db.valor('SELECT status FROM campeonatos WHERE id = ?', vencido.id), 'inscricoes');
  });

  it('modalidade diferente da do campeonato é recusada', async () => {
    const shooter = await amb.novoTime(dono.cliente, { modalidade: 'shooter', titulares: 5 });

    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: shooter.id
    });

    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /Shooter/);
  });

  it('sem campeonato ou sem time, 400; com time de outra conta, 403', async () => {
    const vazio = await dono.cliente.post('/api/inscricoes', {});
    assert.equal(vazio.status, 400);

    const alheio = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: amb.SEMEADOS.timeFutebol
    });
    assert.equal(alheio.status, 403);
  });

  /* ------------------------------------------------------------------------
     INSCRIÇÃO
     ------------------------------------------------------------------------ */

  it('a inscrição nasce em triagem, com protocolo e e-mail que não promete vaga', async () => {
    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: alfa.id
    });

    assert.equal(r.status, 200);
    assert.equal(r.corpo.inscricao.status, 'triagem');
    assert.match(r.corpo.protocolo, /^\d{4}-\d{6}$/);

    const confirmacao = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'inscricao-confirmada' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    assert.ok(confirmacao, 'o responsável precisa receber a confirmação');
    /* A frase é exigência explícita do briefing. */
    assert.match(confirmacao.corpo, /não garante vaga/i);
    assert.ok(confirmacao.assunto.includes(r.corpo.protocolo));
    assert.ok(!confirmacao.corpo.includes('{{'), 'sobrou variável sem substituir');

    const alerta = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'adm-nova-inscricao' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    assert.ok(alerta && alerta.qtd >= 1, 'a administração precisa ser avisada');

    /* Em desenvolvimento nada sai de verdade: fica gravado como simulado. */
    assert.equal(confirmacao.status, 'simulado');
  });

  it('inscrever o mesmo time duas vezes devolve 409 com o protocolo que já existe', async () => {
    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: alfa.id
    });

    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /já está inscrito/i);
    assert.ok(r.corpo.protocolo);
    assert.equal(db.valor(
      'SELECT COUNT(*) FROM inscricoes WHERE campeonato_id = ? AND time_id = ?', aberto.id, alfa.id
    ), 1);
  });

  it('o competidor vê as próprias inscrições; o administrador vê todas', async () => {
    const dele = await dono.cliente.get('/api/inscricoes');
    assert.equal(dele.status, 200);
    assert.ok(dele.corpo.inscricoes.every((i) => [alfa.id, beta.id, gama.id, curto.id].includes(i.time)));
    assert.ok(dele.corpo.inscricoes[0].timeNome);
    assert.ok(dele.corpo.inscricoes[0].campeonatoNome);

    const todas = await mestre.get('/api/inscricoes');
    assert.equal(todas.corpo.total, db.valor('SELECT COUNT(*) FROM inscricoes'));
    assert.ok(todas.corpo.total > dele.corpo.total);

    const filtroTorto = await mestre.get('/api/inscricoes?status=xpto');
    assert.equal(filtroTorto.status, 400);
  });

  /* ------------------------------------------------------------------------
     LISTAS E VAGAS
     ------------------------------------------------------------------------ */

  it('as contagens acompanham a tabela a cada mudança de lista', async () => {
    /* Confere a resposta da API contra um SELECT feito na hora — se algum dia
       alguém trocar o cálculo por um contador guardado, é aqui que aparece. */
    const conferir = (resposta, etapa) => {
      assert.deepEqual(resposta.corpo.contagens, amb.contagensNoBanco(aberto.id), etapa);
    };

    const daBeta = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: beta.id
    });
    conferir(daBeta, 'depois da segunda inscrição');

    const daGama = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: gama.id
    });
    conferir(daGama, 'depois da terceira inscrição');
    assert.equal(daGama.corpo.contagens.triagem, 3);

    const daAlfa = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', alfa.id);
    const idBeta = daBeta.corpo.inscricao.id;
    const idGama = daGama.corpo.inscricao.id;

    const oficialAlfa = await mestre.post(`/api/inscricoes/${daAlfa}/status`, { status: 'oficial' });
    assert.equal(oficialAlfa.corpo.para, 'oficial');
    conferir(oficialAlfa, 'depois de promover a Alfa');

    const oficialBeta = await mestre.post(`/api/inscricoes/${idBeta}/status`, { status: 'oficial' });
    conferir(oficialBeta, 'depois de promover a Beta');
    assert.equal(oficialBeta.corpo.contagens.oficial, 2);

    /* Duas vagas, duas confirmadas: a terceira não cabe. */
    const estourou = await mestre.post(`/api/inscricoes/${idGama}/status`, { status: 'oficial' });
    assert.equal(estourou.status, 409);
    assert.match(estourou.corpo.erro, /vagas/i);
    assert.equal(estourou.corpo.vagas, 2);
    assert.deepEqual(amb.contagensNoBanco(aberto.id).oficial, 2, 'a recusa não podia alterar nada');

    const espera = await mestre.post(`/api/inscricoes/${idGama}/status`, { status: 'espera' });
    assert.equal(espera.status, 200);
    conferir(espera, 'depois de mandar a Gama para a espera');
    assert.equal(espera.corpo.contagens.espera, 1);

    /* Cancelar abre vaga e a Gama sobe. */
    const cancelada = await mestre.post(`/api/inscricoes/${idBeta}/status`, {
      status: 'cancelada', observacao: 'Desistência do responsável.'
    });
    assert.equal(cancelada.status, 200);
    conferir(cancelada, 'depois do cancelamento');

    const promovida = await mestre.post(`/api/inscricoes/${idGama}/status`, { status: 'oficial' });
    assert.equal(promovida.status, 200);
    conferir(promovida, 'depois de promover a Gama');

    /* E o número que o site publica é o mesmo. */
    const publico = await amb.anonimo().get(`/api/campeonatos/${aberto.id}`);
    assert.equal(publico.corpo.campeonato.inscritos, amb.contagensNoBanco(aberto.id).inscritos);
    assert.equal(publico.corpo.campeonato.oficial, amb.contagensNoBanco(aberto.id).oficial);

    const doAdmin = await mestre.get(`/api/inscricoes?campeonato=${aberto.id}`);
    assert.deepEqual(doAdmin.corpo.contagens, amb.contagensNoBanco(aberto.id));
  });

  it('cada transição de lista dispara o e-mail do briefing', async () => {
    const modelos = db.todos(
      `SELECT modelo_id FROM emails_enviados
        WHERE modelo_id IN ('lista-oficial', 'lista-espera', 'adm-vagas-preenchidas')
        GROUP BY modelo_id`
    ).map((l) => l.modelo_id).sort();

    assert.deepEqual(modelos, ['adm-vagas-preenchidas', 'lista-espera', 'lista-oficial']);

    const cancelamento = db.um(
      "SELECT * FROM emails_enviados WHERE assunto LIKE 'Inscrição cancelada%' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    assert.ok(cancelamento, 'o cancelamento também avisa o responsável');
    assert.ok(!cancelamento.corpo.includes('{{'));
  });

  it('cancelar exige observação e status inventado é recusado', async () => {
    const inscricao = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', gama.id);

    const semMotivo = await mestre.post(`/api/inscricoes/${inscricao}/status`, { status: 'cancelada' });
    assert.equal(semMotivo.status, 400);

    const inventado = await mestre.post(`/api/inscricoes/${inscricao}/status`, { status: 'voando' });
    assert.equal(inventado.status, 400);

    const inexistente = await mestre.post('/api/inscricoes/nao-existe/status', { status: 'oficial' });
    assert.equal(inexistente.status, 404);
  });

  it('repetir o mesmo status não altera nada nem dispara e-mail', async () => {
    const inscricao = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', gama.id);
    const antes = db.valor('SELECT COUNT(*) FROM emails_enviados');

    const r = await mestre.post(`/api/inscricoes/${inscricao}/status`, { status: 'oficial' });

    assert.equal(r.status, 200);
    assert.equal(r.corpo.alterado, false);
    assert.equal(db.valor('SELECT COUNT(*) FROM emails_enviados'), antes);
  });

  /* ------------------------------------------------------------------------
     CANCELAMENTO PELO RESPONSÁVEL
     ------------------------------------------------------------------------ */

  it('o responsável cancela a própria inscrição enquanto o prazo está aberto', async () => {
    const inscricao = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', gama.id);

    const r = await dono.cliente.apagar(`/api/inscricoes/${inscricao}`, {
      motivo: 'Elenco desfalcado'
    });

    assert.equal(r.status, 200);
    assert.equal(r.corpo.inscricao.status, 'cancelada');
    assert.deepEqual(r.corpo.contagens, amb.contagensNoBanco(aberto.id));

    /* Cancelar de novo é inócuo, não erro. */
    const denovo = await dono.cliente.apagar(`/api/inscricoes/${inscricao}`);
    assert.equal(denovo.status, 200);
    assert.equal(denovo.corpo.alterado, false);
  });

  it('reinscrever depois de cancelar reaproveita a linha com protocolo novo', async () => {
    const antiga = db.um('SELECT * FROM inscricoes WHERE time_id = ?', gama.id);

    const r = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: aberto.id, timeId: gama.id
    });

    assert.equal(r.status, 200);
    /* O índice único é (campeonato, time): cancelar uma vez não pode barrar o
       time para sempre. */
    assert.equal(r.corpo.inscricao.id, antiga.id);
    assert.notEqual(r.corpo.protocolo, antiga.protocolo);
    assert.equal(r.corpo.inscricao.status, 'triagem');
  });

  it('inscrição de outra conta não é cancelada pelo competidor', async () => {
    const estranho = amb.novoCompetidor('Estranho');
    const inscricao = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', gama.id);

    const r = await estranho.cliente.apagar(`/api/inscricoes/${inscricao}`);
    assert.equal(r.status, 403);
    assert.notEqual(db.valor('SELECT status FROM inscricoes WHERE id = ?', inscricao), 'cancelada');
  });

  it('depois do prazo, cancelar deixa de ser possível e passa a exigir chamado', async () => {
    /* O campeonato fecha as inscrições: o competidor perde o botão. */
    await mestre.post(`/api/campeonatos/${aberto.id}/status`, { status: 'fechado' });

    const inscricao = db.valor('SELECT id FROM inscricoes WHERE time_id = ?', gama.id);
    const r = await dono.cliente.apagar(`/api/inscricoes/${inscricao}`, { motivo: 'mudei de ideia' });

    assert.equal(r.status, 409);
    assert.equal(r.corpo.exigeChamado, true);
    assert.notEqual(db.valor('SELECT status FROM inscricoes WHERE id = ?', inscricao), 'cancelada');
  });

  it('cada escrita deixou registro de auditoria assinado', () => {
    const linhas = db.todos(
      "SELECT * FROM auditoria WHERE area = 'inscricao' ORDER BY id DESC LIMIT 10"
    );

    assert.ok(linhas.length >= 5);
    assert.ok(linhas.every((l) => l.autor && l.autor !== 'sistema'));
    assert.ok(linhas.every((l) => l.ip));
    assert.ok(linhas.some((l) => /Lista Oficial/.test(l.acao)));
  });
});
