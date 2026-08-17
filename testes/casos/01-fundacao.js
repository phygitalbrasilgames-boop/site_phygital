/* ==========================================================================
   FUNDAÇÃO — o servidor subiu inteiro e o contrato do bootstrap vale

   O front-end é estático e lê PB.dados.* de forma síncrona: ele faz UMA
   chamada a /api/bootstrap e passa a viver do que veio nela. Se este arquivo
   falha, todo o resto do site falha junto, sem erro visível na tela.
   ========================================================================== */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

describe('fundação', () => {
  it('todos os 9 módulos de rota carregaram, nenhum com falha', async () => {
    const r = await amb.anonimo().get('/api/_saude');

    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.modulosComFalha, []);
    assert.deepEqual(r.corpo.modulosCarregados, [
      'bootstrap', 'auth', 'campeonatos', 'times',
      'inscricoes', 'chamados', 'conteudo', 'admin', 'email'
    ]);
    assert.ok(r.corpo.rotasRegistradas >= 100, `só ${r.corpo.rotasRegistradas} rotas registradas`);
  });

  it('/api/ping responde sem tocar em sessão', async () => {
    const r = await amb.anonimo().get('/api/ping');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.modo, 'api');
    /* É o que o front-end usa para decidir entre modo api e modo local; não
       pode devolver Set-Cookie nem depender de quem está logado. */
    assert.deepEqual(r.cookies, []);
  });

  it('rota inexistente devolve 404 e método errado devolve 405', async () => {
    const cli = amb.anonimo();

    const inexistente = await cli.get('/api/nao-existe');
    assert.equal(inexistente.status, 404);

    const metodoErrado = await cli.put('/api/ping', {});
    assert.equal(metodoErrado.status, 405);
  });

  it('corpo que não é JSON de objeto é recusado com 400', async () => {
    const cli = amb.anonimo();

    const quebrado = await cli.post('/api/auth/login', '{isso não é json', { cru: true });
    assert.equal(quebrado.status, 400);

    const arrayNaRaiz = await cli.post('/api/auth/login', '[1,2,3]', { cru: true });
    assert.equal(arrayNaRaiz.status, 400);
  });

  it('bootstrap sem sessão traz o conteúdo público e nada de conta', async () => {
    const r = await amb.anonimo().get('/api/bootstrap');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.modo, 'api');
    assert.equal(r.corpo.conta, null);

    const d = r.corpo.dados;
    assert.equal(d.usuario, null);
    assert.ok(d.campeonatos.length > 0, 'o site precisa de campeonatos na home');
    assert.ok(d.posts.length > 0);
    assert.ok(d.parceiros.length > 0);

    /* O piso do payload: toda chave que a semente antiga do front-end tinha
       existe, vazia — nenhuma página recebe undefined no lugar de uma lista. */
    for (const chave of ['meusTimes', 'minhasInscricoes', 'chamados', 'adminChamados',
      'adminUsuarios', 'emailsEnviados', 'auditoria', 'modelosEmail']) {
      assert.deepEqual(d[chave], [], `${chave} deveria vir vazio sem sessão`);
    }
    assert.deepEqual(d.smtp, {});
  });

  it('bootstrap público não publica rascunho nem campeonato arquivado', async () => {
    const publicados = amb.db.valor(
      'SELECT COUNT(*) FROM posts WHERE publicado = 1 AND arquivado_em IS NULL'
    );
    const r = await amb.anonimo().get('/api/bootstrap');

    assert.equal(r.corpo.dados.posts.length, publicados);
    assert.ok(r.corpo.dados.posts.every((p) => p.rascunho !== true));

    const arquivados = amb.db.todos('SELECT id FROM campeonatos WHERE arquivado_em IS NOT NULL');
    for (const linha of arquivados) {
      assert.ok(!r.corpo.dados.campeonatos.some((c) => c.id === linha.id));
    }
  });

  it('bootstrap do competidor traz os times dele com o elenco aninhado', async () => {
    const r = await amb.comoCompetidor().get('/api/bootstrap');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.conta.papel, 'competidor');
    assert.equal(r.corpo.conta.destino, 'inicio.html');

    const d = r.corpo.dados;
    assert.equal(d.meusTimes.length, 2);

    const tigres = d.meusTimes.find((t) => t.id === amb.SEMEADOS.timeFutebol);
    assert.ok(Array.isArray(tigres.jogadores) && tigres.jogadores.length > 0);
    assert.ok(Array.isArray(tigres.staff));
    assert.ok(Array.isArray(tigres.jogadores[0].documentos));

    /* Competidor não enxerga a fila do administrador. */
    assert.deepEqual(d.adminChamados, []);
    assert.deepEqual(d.adminUsuarios, []);
    assert.deepEqual(d.auditoria, []);
  });

  it('bootstrap do admin traz fila, usuários, SMTP e auditoria', async () => {
    const r = await amb.comoMaster().get('/api/bootstrap');

    assert.equal(r.corpo.conta.papel, 'admin');
    assert.equal(r.corpo.conta.destino, '../admin/index.html');

    const d = r.corpo.dados;
    assert.ok(d.adminChamados.length > 0);
    assert.ok(d.adminUsuarios.length > 0);
    assert.ok(d.modelosEmail.length > 0);
    assert.ok(d.auditoria.length > 0);
    assert.ok(d.smtp && d.smtp.email);

    /* A tela Minha Conta do admin lê adminUsuarios()[0] como sendo ele mesmo. */
    assert.equal(d.adminUsuarios[0].id, amb.CONTAS.master.id);
  });

  it('as regras de elenco do bootstrap são as do servidor, não uma cópia', async () => {
    const r = await amb.anonimo().get('/api/bootstrap');

    assert.deepEqual(Object.keys(r.corpo.modalidades), Object.keys(amb.regras.MODALIDADES));

    for (const [id, m] of Object.entries(amb.regras.MODALIDADES)) {
      const doPayload = r.corpo.modalidades[id];
      assert.equal(doPayload.jogadoresMin, m.jogadoresMin, `${id}.jogadoresMin`);
      assert.equal(doPayload.jogadoresMax, m.jogadoresMax, `${id}.jogadoresMax`);
      assert.equal(doPayload.reservasMax, m.reservasMax, `${id}.reservasMax`);
      assert.equal(doPayload.staffMax, m.staffMax, `${id}.staffMax`);
    }
  });

  it('as respostas trazem os cabeçalhos de segurança', async () => {
    const r = await amb.anonimo().get('/api/ping');

    assert.equal(r.cabecalhos.get('x-content-type-options'), 'nosniff');
    assert.equal(r.cabecalhos.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.cabecalhos.get('cache-control'), 'no-store');
    assert.match(r.cabecalhos.get('content-security-policy'), /default-src 'self'/);
  });

  it('escrita vinda de outra origem é bloqueada (CSRF)', async () => {
    const cli = amb.comoCompetidor();

    const cruzada = await cli.post('/api/inscricoes', { campeonatoId: 'x', timeId: 'y' },
      { cabecalhos: { origin: 'https://site-malicioso.exemplo' } });
    assert.equal(cruzada.status, 403);
    assert.match(cruzada.corpo.erro, /cruzada/i);

    /* Da própria origem passa (e cai na validação de negócio, não na de origem). */
    const propria = await cli.post('/api/inscricoes', {},
      { cabecalhos: { origin: amb.base } });
    assert.equal(propria.status, 400);
  });
});
