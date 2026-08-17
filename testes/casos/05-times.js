/* ==========================================================================
   TIMES — propriedade, limites de elenco e a trava de edição

   A trava é a regra transversal do briefing: o competidor edita à vontade até
   a data de encerramento das inscrições; depois disso, qualquer alteração
   passa por chamado. Não é checagem de tela — vale para toda escrita no time.
   ========================================================================== */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;

describe('times', () => {
  /* ------------------------------------------------------------------------
     PROPRIEDADE
     ------------------------------------------------------------------------ */

  it('o competidor lê só os próprios times', async () => {
    const r = await amb.comoCompetidor().get('/api/times');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.times.length, 2);
    assert.ok(r.corpo.times.every((t) => t.id === 't1' || t.id === 't2'));
    assert.ok(Array.isArray(r.corpo.times[0].jogadores));
  });

  it('o time de outra conta responde 404, não 403', async () => {
    const intruso = amb.novoCompetidor('Intruso dos Times');

    /* 404 e não 403 de propósito: 403 confirmaria que o time existe. */
    const leitura = await intruso.cliente.get(`/api/times/${amb.SEMEADOS.timeFutebol}`);
    assert.equal(leitura.status, 404);

    const escrita = await intruso.cliente.put(`/api/times/${amb.SEMEADOS.timeFutebol}`, {
      nome: 'Tomado'
    });
    assert.equal(escrita.status, 404);

    const jogador = await intruso.cliente.post(`/api/times/${amb.SEMEADOS.timeFutebol}/jogadores`, {
      nome: 'Infiltrado'
    });
    assert.equal(jogador.status, 404);

    /* Nem o nome nem o elenco foram tocados. */
    assert.equal(db.valor('SELECT nome FROM times WHERE id = ?', amb.SEMEADOS.timeFutebol),
      'Tigres Phygital');

    /* E a lista dele continua vazia. */
    const meus = await intruso.cliente.get('/api/times');
    assert.deepEqual(meus.corpo.times, []);
  });

  it('o administrador lê o time de qualquer conta', async () => {
    const r = await amb.comoOperacao().get(`/api/times/${amb.SEMEADOS.timeFutebol}`);
    assert.equal(r.status, 200);
    assert.equal(r.corpo.time.nome, 'Tigres Phygital');

    const filtrado = await amb.comoMaster().get('/api/times?modalidade=shooter');
    assert.equal(filtrado.status, 200);
    assert.ok(filtrado.corpo.times.every((t) => t.modalidade === 'shooter'));
  });

  /* ------------------------------------------------------------------------
     CADASTRO
     ------------------------------------------------------------------------ */

  it('futebol exige categoria válida; dança e shooter não têm categoria', async () => {
    const dono = amb.novoCompetidor('Dono do Cadastro');

    const semCategoria = await dono.cliente.post('/api/times', {
      nome: 'Sem Categoria FC', modalidade: 'futebol'
    });
    assert.equal(semCategoria.status, 400);

    const categoriaInventada = await dono.cliente.post('/api/times', {
      nome: 'Categoria Errada FC', modalidade: 'futebol', categoria: 'Sub 12'
    });
    assert.equal(categoriaInventada.status, 400);

    const modalidadeInventada = await dono.cliente.post('/api/times', {
      nome: 'Vôlei FC', modalidade: 'volei'
    });
    assert.equal(modalidadeInventada.status, 400);

    const certo = await dono.cliente.post('/api/times', {
      nome: 'Categoria Certa FC', modalidade: 'futebol', categoria: 'Sub 17'
    });
    assert.equal(certo.status, 201);
    assert.equal(certo.corpo.time.categoria, 'Sub 17');

    const danca = await dono.cliente.post('/api/times', { nome: 'Solo Dance', modalidade: 'dance' });
    assert.equal(danca.status, 201);
  });

  /* ------------------------------------------------------------------------
     LIMITES POR MODALIDADE
     ------------------------------------------------------------------------ */

  it('futebol para no 9º titular e na 4ª reserva', async () => {
    const dono = amb.novoCompetidor('Dono do Futebol');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'futebol', titulares: 8, reservas: 3 });

    const nono = await dono.cliente.post(`/api/times/${time.id}/jogadores`, { nome: 'Nono Titular' });
    assert.equal(nono.status, 409);

    const quarta = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Quarta Reserva', reserva: true
    });
    assert.equal(quarta.status, 409);

    const elenco = await dono.cliente.get(`/api/times/${time.id}/elenco`);
    assert.equal(elenco.corpo.valido, true);
    assert.equal(elenco.corpo.titulares, 8);
    assert.equal(elenco.corpo.reservas, 3);
  });

  it('dança é individual e não aceita reserva', async () => {
    const dono = amb.novoCompetidor('Dono da Danca');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'dance', titulares: 1 });

    const segundo = await dono.cliente.post(`/api/times/${time.id}/jogadores`, { nome: 'Dupla' });
    assert.equal(segundo.status, 409);

    const reserva = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Reserva de Dança', reserva: true
    });
    assert.equal(reserva.status, 409);
  });

  it('shooter exige Steam64 e perfil Faceit em cada atleta', async () => {
    const dono = amb.novoCompetidor('Dono do Shooter');
    const criado = await dono.cliente.post('/api/times', {
      nome: 'Squad de Teste', modalidade: 'shooter'
    });
    const time = criado.corpo.time;

    const semNada = await dono.cliente.post(`/api/times/${time.id}/jogadores`, { nome: 'Sem Steam' });
    assert.equal(semNada.status, 400);

    const steamTorto = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Steam Torto', steam: '123', faceit: 'https://www.faceit.com/br/players/x'
    });
    assert.equal(steamTorto.status, 400);

    const faceitTorto = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Faceit Torto', steam: '76561198000000009', faceit: 'perfil-do-faceit'
    });
    assert.equal(faceitTorto.status, 400);

    const certo = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Atleta Completo',
      steam: '76561198000000009',
      faceit: 'https://www.faceit.com/br/players/atleta',
      numero: 7
    });
    assert.equal(certo.status, 201);
    /* Shooter não usa camisa: o campo é ignorado em vez de virar lixo no banco. */
    assert.equal(certo.corpo.jogador.numero, null);
  });

  it('a comissão técnica respeita o teto da modalidade', async () => {
    const dono = amb.novoCompetidor('Dono da Comissao');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'shooter', titulares: 5 });

    const treinador = await dono.cliente.post(`/api/times/${time.id}/staff`, {
      nome: 'Treinador', papel: 'Treinador'
    });
    assert.equal(treinador.status, 201);

    /* Shooter: só o treinador. */
    const extra = await dono.cliente.post(`/api/times/${time.id}/staff`, { nome: 'Auxiliar' });
    assert.equal(extra.status, 409);

    const alterado = await dono.cliente.put(
      `/api/times/${time.id}/staff/${treinador.corpo.staff.id}`, { papel: 'Head Coach' }
    );
    assert.equal(alterado.corpo.staff.papel, 'Head Coach');

    const removido = await dono.cliente.apagar(`/api/times/${time.id}/staff/${treinador.corpo.staff.id}`);
    assert.equal(removido.status, 200);
  });

  it('dado inválido de jogador é recusado antes de gravar', async () => {
    const dono = amb.novoCompetidor('Dono das Validacoes');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'basquete', titulares: 3 });

    const semNome = await dono.cliente.post(`/api/times/${time.id}/jogadores`, { nome: '  ' });
    assert.equal(semNome.status, 400);

    const dataTorta = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Data Errada', nasc: '01/02/2000'
    });
    assert.equal(dataTorta.status, 400);

    const emailTorto = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'E-mail Errado', email: 'arroba-faltando'
    });
    assert.equal(emailTorto.status, 400);

    assert.equal(db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ?', time.id), 3);
  });

  /* ------------------------------------------------------------------------
     TRAVA DE EDIÇÃO
     ------------------------------------------------------------------------ */

  it('com as inscrições encerradas, toda escrita no time devolve 409 pedindo chamado', async () => {
    const mestre = amb.comoMaster();
    const dono = amb.novoCompetidor('Dono do Time Travado');

    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa da Trava de Edição', modalidade: 'futebol', vagas: 8
    });
    const time = await amb.novoTime(dono.cliente, { modalidade: 'futebol', titulares: 6 });

    /* Antes de inscrever, escreve à vontade. */
    const antes = await dono.cliente.put(`/api/times/${time.id}`, { descricao: 'antes da inscrição' });
    assert.equal(antes.status, 200);

    const inscricao = await dono.cliente.post('/api/inscricoes', {
      campeonatoId: campeonato.id, timeId: time.id
    });
    assert.equal(inscricao.status, 200);

    /* Inscrito, mas com o prazo ainda aberto: continua editando. */
    const durante = await dono.cliente.put(`/api/times/${time.id}`, { descricao: 'inscrições abertas' });
    assert.equal(durante.status, 200);

    /* O administrador encerra as inscrições — é aqui que a trava fecha. */
    const fechou = await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'fechado' });
    assert.equal(fechou.status, 200);

    const proibidas = [
      ['PUT', `/api/times/${time.id}`, { descricao: 'depois do fechamento' }],
      ['POST', `/api/times/${time.id}/jogadores`, { nome: 'Reforço Tardio' }],
      ['POST', `/api/times/${time.id}/staff`, { nome: 'Treinador Tardio' }]
    ];

    for (const [metodo, caminho, corpo] of proibidas) {
      const r = await dono.cliente.pedir(metodo, caminho, corpo);
      assert.equal(r.status, 409, `${metodo} ${caminho} deveria estar travado`);
      assert.equal(r.corpo.exigeChamado, true, `${metodo} ${caminho} deveria pedir chamado`);
      assert.ok(Array.isArray(r.corpo.travas) && r.corpo.travas.length > 0);
      assert.equal(r.corpo.travas[0].campeonato, campeonato.id);
    }

    /* Excluir o time também é barrado, mas por um motivo mais específico: a
       inscrição ativa vem antes da trava porque explica melhor o que fazer. */
    const exclusao = await dono.cliente.apagar(`/api/times/${time.id}`);
    assert.equal(exclusao.status, 409);
    assert.ok(Array.isArray(exclusao.corpo.inscricoes) && exclusao.corpo.inscricoes.length > 0);

    /* E o banco continua exatamente como estava. */
    assert.equal(db.valor('SELECT descricao FROM times WHERE id = ?', time.id), 'inscrições abertas');
    assert.equal(db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ?', time.id), 6);

    /* Ler nunca é travado — só escrever. */
    const leitura = await dono.cliente.get(`/api/times/${time.id}`);
    assert.equal(leitura.status, 200);
  });

  it('prazo vencido trava do mesmo jeito, mesmo com o campeonato ainda em inscrições', async () => {
    const mestre = amb.comoMaster();
    const dono = amb.novoCompetidor('Dono do Prazo Vencido');

    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa do Prazo Vencido', modalidade: 'basquete', vagas: 8, prazo: 'vencido'
    });
    const time = await amb.novoTime(dono.cliente, { modalidade: 'basquete', titulares: 3 });

    /* O prazo já passou, então a inscrição vai direto para o banco: é o
       cenário de quem se inscreveu a tempo e só depois o prazo venceu. */
    db.executar(
      `INSERT INTO inscricoes (id, campeonato_id, time_id, protocolo, status, data, criado_em)
       VALUES (?, ?, ?, ?, 'oficial', ?, ?)`,
      `insc-vencida-${time.id}`, campeonato.id, time.id,
      amb.regras.proximoProtocolo('inscricoes'), amb.emDias(-20), db.agora()
    );

    assert.equal(db.valor('SELECT status FROM campeonatos WHERE id = ?', campeonato.id), 'inscricoes');

    const r = await dono.cliente.put(`/api/times/${time.id}`, { descricao: 'tarde demais' });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.exigeChamado, true);
  });

  /* ------------------------------------------------------------------------
     EXCLUSÃO
     ------------------------------------------------------------------------ */

  it('time com inscrição ativa não pode ser excluído; sem inscrição, some da leitura', async () => {
    const dono = amb.novoCompetidor('Dono da Exclusao');

    const semInscricao = await amb.novoTime(dono.cliente, { modalidade: 'dance', titulares: 1 });
    const removido = await dono.cliente.apagar(`/api/times/${semInscricao.id}`);
    assert.equal(removido.status, 200);
    assert.equal((await dono.cliente.get(`/api/times/${semInscricao.id}`)).status, 404);

    const comInscricao = await amb.comoCompetidor().apagar(`/api/times/${amb.SEMEADOS.timeFutebol}`);
    assert.equal(comInscricao.status, 409);
    assert.ok(db.um('SELECT id FROM times WHERE id = ?', amb.SEMEADOS.timeFutebol));
  });

  /* ------------------------------------------------------------------------
     DOCUMENTAÇÃO
     ------------------------------------------------------------------------ */

  it('o menor de idade ganha a exigência de autorização do responsável', async () => {
    const dono = amb.novoCompetidor('Dono dos Documentos');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'basquete', titulares: 3 });

    const anoMenor = new Date().getFullYear() - 16;
    const menor = await dono.cliente.post(`/api/times/${time.id}/jogadores`, {
      nome: 'Atleta de Base', nasc: `${anoMenor}-05-10`, reserva: true
    });
    assert.equal(menor.status, 201);

    const ficha = await dono.cliente.get(`/api/times/${time.id}/documentacao`);
    assert.equal(ficha.status, 200);

    const doMenor = ficha.corpo.jogadores.find((j) => j.id === menor.corpo.jogador.id);
    const doMaior = ficha.corpo.jogadores.find((j) => j.id !== menor.corpo.jogador.id);

    assert.ok(doMenor.documentos.some((d) => d.tipo === 'responsavel'));
    assert.ok(!doMaior.documentos.some((d) => d.tipo === 'responsavel'));
  });

  it('só o master confere documento, e recusa exige motivo', async () => {
    const dono = amb.novoCompetidor('Dono da Conferencia');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'basquete', titulares: 3 });
    const jogador = db.valor('SELECT id FROM jogadores WHERE time_id = ? LIMIT 1', time.id);

    const semValidade = await dono.cliente.put(
      `/api/times/${time.id}/jogadores/${jogador}/documentos/identidade`, { arquivo: 'rg.pdf' }
    );
    assert.equal(semValidade.status, 400);

    const enviado = await dono.cliente.put(
      `/api/times/${time.id}/jogadores/${jogador}/documentos/identidade`,
      { arquivo: 'rg.pdf', validade: '2031-01-01' }
    );
    assert.equal(enviado.status, 200);
    assert.equal(enviado.corpo.documento.status, 'enviado');
    const documento = enviado.corpo.documento.id;

    const tipoInventado = await dono.cliente.put(
      `/api/times/${time.id}/jogadores/${jogador}/documentos/passaporte`, { arquivo: 'x.pdf' }
    );
    assert.equal(tipoInventado.status, 400);

    assert.equal((await dono.cliente.post(`/api/documentos/${documento}/conferir`,
      { status: 'aprovado' })).status, 403);
    assert.equal((await amb.comoGestor().post(`/api/documentos/${documento}/conferir`,
      { status: 'aprovado' })).status, 403);

    const mestre = amb.comoMaster();
    const semMotivo = await mestre.post(`/api/documentos/${documento}/conferir`, { status: 'recusado' });
    assert.equal(semMotivo.status, 400);

    const recusado = await mestre.post(`/api/documentos/${documento}/conferir`, {
      status: 'recusado', observacao: 'Foto ilegível.'
    });
    assert.equal(recusado.status, 200);
    assert.equal(recusado.corpo.documento.status, 'recusado');

    const inventado = await mestre.post(`/api/documentos/${documento}/conferir`, { status: 'talvez' });
    assert.equal(inventado.status, 400);
  });
});
