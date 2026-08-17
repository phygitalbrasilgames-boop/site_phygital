/* ==========================================================================
   CAMPEONATOS — ciclo de vida, apuração e ranking

   Criar → Publicar → Encerrar inscrições → Iniciar → Apurar → Encerrado.

   A apuração é o único caminho que escreve no ranking global: o administrador
   ordena a classificação final à mão e é isso que vira participação e título.
   Nada mais alimenta aquela tabela.
   ========================================================================== */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;

/** Linha do ranking global de uma modalidade, direto do banco. */
const noRanking = (modalidade, nome) => db.um(
  'SELECT * FROM ranking WHERE modalidade = ? AND nome = ?', modalidade, nome
);

describe('campeonatos', () => {
  let mestre;

  before(() => { mestre = amb.comoMaster(); });

  /* ------------------------------------------------------------------------
     LEITURA PÚBLICA
     ------------------------------------------------------------------------ */

  it('a lista pública filtra por modalidade e por status', async () => {
    const cli = amb.anonimo();

    const todos = await cli.get('/api/campeonatos');
    assert.equal(todos.status, 200);
    assert.ok(todos.corpo.campeonatos.length > 0);

    const futebol = await cli.get('/api/campeonatos?modalidade=futebol');
    assert.ok(futebol.corpo.campeonatos.every((c) => c.modalidade === 'futebol'));

    const encerrados = await cli.get('/api/campeonatos?status=encerrado');
    assert.ok(encerrados.corpo.campeonatos.every((c) => c.status === 'encerrado'));

    const inventado = await cli.get('/api/campeonatos?status=banana');
    assert.equal(inventado.status, 400);

    /* A home esconde a seção inteira quando não há inscrição aberta, então a
       rota precisa devolver só o que está mesmo aberto. */
    const abertas = await cli.get('/api/campeonatos/abertas');
    assert.ok(abertas.corpo.campeonatos.every((c) => c.status === 'inscricoes'));
  });

  it('o detalhe recalcula os inscritos a partir da tabela', async () => {
    const id = amb.SEMEADOS.campeonatoFutebol;
    const r = await amb.anonimo().get(`/api/campeonatos/${id}`);

    assert.equal(r.status, 200);
    assert.equal(r.corpo.campeonato.id, id);
    assert.equal(typeof r.corpo.inscricao.aberta, 'boolean');
    assert.equal(r.corpo.campeonato.inscritos, amb.contagensNoBanco(id).inscritos);

    assert.equal((await amb.anonimo().get('/api/campeonatos/nao-existe')).status, 404);
  });

  /* ------------------------------------------------------------------------
     CRIAÇÃO
     ------------------------------------------------------------------------ */

  it('o campeonato nasce em rascunho, com id legível e os limites da modalidade', async () => {
    const r = await mestre.post('/api/campeonatos', {
      nome: 'Copa de Teste Automatizado 2027',
      modalidade: 'basquete',
      vagas: 12,
      data: amb.emDias(300),
      dataFim: amb.emDias(301),
      local: 'Arena de Teste',
      aberturaInscricoes: amb.emDias(10),
      encerramentoInscricoes: amb.emDias(200),
      termos: 'Termos de teste'
    });

    assert.equal(r.status, 201);
    const c = r.corpo.campeonato;
    assert.equal(c.status, 'rascunho');
    assert.match(c.id, /^copa-de-teste/);
    assert.equal(c.jogadoresMin, 3);
    assert.equal(c.jogadoresMax, 4);
    assert.equal(c.reservasMax, 2);
    assert.equal(c.staffMax, 2);
    assert.equal(c.inscritos, 0);
  });

  it('a modalidade é o teto: o campeonato pode apertar a regra, nunca afrouxar', async () => {
    const acima = await mestre.post('/api/campeonatos', {
      nome: 'Basquete com nove', modalidade: 'basquete', jogadoresMax: 9
    });
    assert.equal(acima.status, 400);

    const apertado = await mestre.post('/api/campeonatos', {
      nome: 'Futebol apertado', modalidade: 'futebol', jogadoresMin: 7, jogadoresMax: 7
    });
    assert.equal(apertado.status, 201);
    assert.equal(apertado.corpo.campeonato.jogadoresMin, 7);
  });

  it('modalidade desconhecida e datas incoerentes são recusadas', async () => {
    const modalidade = await mestre.post('/api/campeonatos', {
      nome: 'Campeonato de Vôlei', modalidade: 'volei'
    });
    assert.equal(modalidade.status, 400);

    const datas = await mestre.post('/api/campeonatos', {
      nome: 'Datas Tortas',
      modalidade: 'futebol',
      aberturaInscricoes: amb.emDias(90),
      encerramentoInscricoes: amb.emDias(10)
    });
    assert.equal(datas.status, 400);
  });

  it('o PUT edita, preserva o que não veio e ignora status e classificação', async () => {
    const criado = await mestre.post('/api/campeonatos', {
      nome: 'Copa de Edição', modalidade: 'basquete', vagas: 8, termos: 'Termos originais'
    });
    const id = criado.corpo.campeonato.id;

    const r = await mestre.put(`/api/campeonatos/${id}`, {
      vagas: 16, local: 'Ginásio Novo', status: 'encerrado', classificacao: [{ nome: 'Trapaça' }]
    });

    assert.equal(r.status, 200);
    assert.equal(r.corpo.campeonato.vagas, 16);
    assert.equal(r.corpo.campeonato.local, 'Ginásio Novo');
    /* Status só muda pela rota de ciclo de vida; classificação, pela apuração. */
    assert.equal(r.corpo.campeonato.status, 'rascunho');
    assert.equal(r.corpo.campeonato.classificacao, null);
    assert.equal(r.corpo.campeonato.termos, 'Termos originais');
    assert.equal(r.corpo.campeonato.jogadoresMax, 4);
  });

  /* ------------------------------------------------------------------------
     CICLO DE VIDA
     ------------------------------------------------------------------------ */

  it('transição fora da ordem devolve 409 dizendo quais são as possíveis', async () => {
    const criado = await mestre.post('/api/campeonatos', {
      nome: 'Copa do Ciclo de Vida', modalidade: 'basquete', vagas: 8,
      data: amb.emDias(120), aberturaInscricoes: amb.emDias(5),
      encerramentoInscricoes: amb.emDias(100)
    });
    const id = criado.corpo.campeonato.id;

    /* rascunho só vai para inscricoes. */
    const pulou = await mestre.post(`/api/campeonatos/${id}/status`, { status: 'andamento' });
    assert.equal(pulou.status, 409);
    assert.match(pulou.corpo.erro, /Transições possíveis/);

    const encerrouDireto = await mestre.post(`/api/campeonatos/${id}/status`, { status: 'encerrado' });
    assert.equal(encerrouDireto.status, 409);

    const inventado = await mestre.post(`/api/campeonatos/${id}/status`, { status: 'voando' });
    assert.equal(inventado.status, 400);

    assert.equal(db.valor('SELECT status FROM campeonatos WHERE id = ?', id), 'rascunho');
  });

  it('publicar sem data nem vaga é recusado com a lista do que falta', async () => {
    const criado = await mestre.post('/api/campeonatos', {
      nome: 'Copa Sem Datas', modalidade: 'dance'
    });

    const r = await mestre.post(`/api/campeonatos/${criado.corpo.campeonato.id}/status`, {
      status: 'inscricoes'
    });

    assert.equal(r.status, 409);
    assert.ok(Array.isArray(r.corpo.faltando));
    assert.ok(r.corpo.faltando.includes('encerramento das inscrições'));
  });

  it('encerrar as inscrições avisa por e-mail com as variáveis substituídas', async () => {
    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa do Aviso de Encerramento', modalidade: 'basquete', vagas: 8
    });

    const antes = db.valor('SELECT COUNT(*) FROM emails_enviados');
    const r = await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'fechado' });

    assert.equal(r.status, 200);
    assert.equal(r.corpo.campeonato.status, 'fechado');
    assert.ok(db.valor('SELECT COUNT(*) FROM emails_enviados') > antes);

    const alerta = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'adm-inscricoes-encerradas' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    assert.ok(alerta);
    assert.ok(alerta.assunto.includes('Copa do Aviso de Encerramento'));
    assert.ok(!alerta.corpo.includes('{{'), 'sobrou variável sem substituir');
  });

  /* ------------------------------------------------------------------------
     APURAÇÃO E RANKING
     ------------------------------------------------------------------------ */

  it('a apuração alimenta o ranking global e encerra o campeonato', async () => {
    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa da Apuração', modalidade: 'basquete', vagas: 8
    });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'fechado' });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'andamento' });

    const veterano = 'Cangaço 3x3';                 /* já existe no ranking semeado */
    const estreante = 'Time Beta da Apuração';
    const antesVeterano = noRanking('basquete', veterano);
    assert.ok(antesVeterano, 'a semente precisa ter o veterano no ranking');

    const r = await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, {
      classificacao: [
        { pos: 2, nome: estreante, uf: 'RJ' },
        { pos: 1, nome: veterano, uf: 'PE' },
        { pos: 3, nome: 'Time Gama da Apuração', uf: 'MG' }
      ]
    });

    assert.equal(r.status, 200);
    /* A ordem final é por posição, não pela ordem em que o admin digitou. */
    assert.equal(r.corpo.campeonato.classificacao[0].nome, veterano);
    /* Apurar é o último passo do ciclo. */
    assert.equal(r.corpo.campeonato.status, 'encerrado');

    const depoisVeterano = noRanking('basquete', veterano);
    assert.equal(depoisVeterano.camp, antesVeterano.camp + 1, 'participação a mais');
    assert.equal(depoisVeterano.titulos, antesVeterano.titulos + 1, 'título a mais');

    const novo = noRanking('basquete', estreante);
    assert.ok(novo, 'quem nunca apareceu entra no ranking');
    assert.equal(novo.camp, 1);
    assert.equal(novo.titulos, 0);
    assert.equal(novo.uf, 'RJ');
    assert.ok(Number.isInteger(novo.posicao), 'a posição é renumerada na apuração');

    /* E o ranking público reflete o que foi apurado. */
    const publico = await amb.anonimo().get('/api/ranking/basquete');
    assert.equal(publico.status, 200);
    assert.ok(publico.corpo.ranking.some((l) => l.nome === estreante));
  });

  it('reapurar corrige a ordem sem contar a mesma edição duas vezes', async () => {
    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa da Reapuração', modalidade: 'dance', vagas: 8
    });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'fechado' });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'andamento' });

    const primeiro = 'Bailarina Um';
    const segundo = 'Bailarina Dois';

    await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, {
      classificacao: [{ pos: 1, nome: primeiro, uf: 'SP' }, { pos: 2, nome: segundo, uf: 'RJ' }]
    });

    const depoisDaPrimeira = {
      um: noRanking('dance', primeiro),
      dois: noRanking('dance', segundo)
    };
    assert.equal(depoisDaPrimeira.um.camp, 1);
    assert.equal(depoisDaPrimeira.um.titulos, 1);
    assert.equal(depoisDaPrimeira.dois.titulos, 0);

    /* O administrador percebeu que inverteu o pódio. */
    const correcao = await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, {
      classificacao: [{ pos: 1, nome: segundo, uf: 'RJ' }, { pos: 2, nome: primeiro, uf: 'SP' }]
    });
    assert.equal(correcao.status, 200);

    /* Uma edição, uma participação para cada — e o título muda de dono. */
    assert.equal(noRanking('dance', primeiro).camp, 1);
    assert.equal(noRanking('dance', primeiro).titulos, 0);
    assert.equal(noRanking('dance', segundo).camp, 1);
    assert.equal(noRanking('dance', segundo).titulos, 1);
  });

  it('classificação malformada é recusada e o ranking não é tocado', async () => {
    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa da Classificação Torta', modalidade: 'basquete', vagas: 8
    });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'fechado' });
    await mestre.post(`/api/campeonatos/${campeonato.id}/status`, { status: 'andamento' });

    const linhasAntes = db.valor("SELECT COUNT(*) FROM ranking WHERE modalidade = 'basquete'");

    const vazia = await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, { classificacao: [] });
    assert.equal(vazia.status, 400);

    const repetido = await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, {
      classificacao: [{ nome: 'Repetido' }, { nome: 'repetido' }]
    });
    assert.equal(repetido.status, 400);

    const semNome = await mestre.post(`/api/campeonatos/${campeonato.id}/apuracao`, {
      classificacao: [{ pos: 1, uf: 'SP' }]
    });
    assert.equal(semNome.status, 400);

    assert.equal(db.valor("SELECT COUNT(*) FROM ranking WHERE modalidade = 'basquete'"), linhasAntes);
    assert.equal(db.valor('SELECT status FROM campeonatos WHERE id = ?', campeonato.id), 'andamento');
  });

  it('apurar campeonato que ainda está em inscrições devolve 409', async () => {
    const r = await mestre.post(`/api/campeonatos/${amb.SEMEADOS.campeonatoFutebol}/apuracao`, {
      classificacao: [{ pos: 1, nome: 'Tigres Phygital', uf: 'SP' }]
    });

    assert.equal(r.status, 409);
  });

  /* ------------------------------------------------------------------------
     DUPLICAR E ARQUIVAR
     ------------------------------------------------------------------------ */

  it('duplicar herda as regras e zera a situação', async () => {
    const original = await amb.novoCampeonato(mestre, {
      nome: 'Copa a Duplicar', modalidade: 'basquete', vagas: 12
    });

    const r = await mestre.post(`/api/campeonatos/${original.id}/duplicar`, {
      ajustes: {
        nome: 'Copa a Duplicar — Edição Seguinte',
        data: amb.emDias(400),
        dataFim: amb.emDias(401),
        aberturaInscricoes: amb.emDias(200),
        encerramentoInscricoes: amb.emDias(380)
      }
    });

    assert.equal(r.status, 201);
    const copia = r.corpo.campeonato;
    assert.notEqual(copia.id, original.id);
    assert.equal(copia.status, 'rascunho');
    assert.equal(copia.classificacao, null);
    assert.equal(copia.inscritos, 0);
    assert.equal(copia.jogadoresMax, original.jogadoresMax);
    assert.equal(copia.vagas, original.vagas);
  });

  it('arquivar tira do site, mantém para o administrador e não vale com inscrição aberta', async () => {
    const campeonato = await amb.novoCampeonato(mestre, {
      nome: 'Copa a Arquivar', modalidade: 'dance', vagas: 8, publicar: false
    });

    const r = await mestre.apagar(`/api/campeonatos/${campeonato.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.corpo.campeonato.arquivado, true);

    const publico = await amb.anonimo().get('/api/campeonatos');
    assert.ok(!publico.corpo.campeonatos.some((c) => c.id === campeonato.id));
    assert.equal((await amb.anonimo().get(`/api/campeonatos/${campeonato.id}`)).status, 404);
    assert.equal((await mestre.get(`/api/campeonatos/${campeonato.id}`)).status, 200);

    /* Campeonato recebendo inscrição não some do ar por engano. */
    const comInscricoes = await mestre.apagar(`/api/campeonatos/${amb.SEMEADOS.campeonatoFutebol}`);
    assert.equal(comInscricoes.status, 409);
  });

  it('a exportação devolve os times com elenco e marca o caso da dança', async () => {
    const id = amb.SEMEADOS.campeonatoFutebol;
    const r = await amb.comoGestor().get(`/api/campeonatos/${id}/exportar?lista=todas`);

    assert.equal(r.status, 200);
    assert.ok(r.corpo.campeonato);
    assert.ok(Array.isArray(r.corpo.times));
    assert.ok(r.corpo.times.every((t) => Array.isArray(t.jogadores)));
    /* Dança exporta foto solta e planilha de aba única — o resto, uma pasta
       por time. O sinalizador é o que a tela usa para escolher. */
    assert.equal(r.corpo.danca, false);

    const lista = await amb.comoMaster().get(`/api/campeonatos/${id}/exportar?lista=inventada`);
    assert.equal(lista.status, 400);
  });

  it('a auditoria registrou cada escrita de campeonato e de ranking', () => {
    const trilha = db.todos(
      "SELECT * FROM auditoria WHERE area IN ('campeonato', 'ranking') ORDER BY id DESC LIMIT 20"
    );

    assert.ok(trilha.length >= 10);
    assert.ok(trilha.some((l) => l.area === 'ranking'));
    assert.ok(trilha.some((l) => l.acao === 'apurou' || l.acao === 'reapurou'));
    assert.ok(trilha.every((l) => l.autor && l.autor !== 'sistema'));
  });
});
