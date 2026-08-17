/* ==========================================================================
   PERMISSÕES E VAZAMENTOS

   Três perguntas, uma por bloco:

     · quem não entrou consegue alguma coisa?        (esperado: 401 em tudo)
     · quem entrou com o papel errado consegue?      (esperado: 403)
     · o servidor devolve algo que não devia?        (hash, sal, senha, SQL)

   O nível "gestor" é o caso mais delicado do briefing: ele existe para LER
   campeonatos, exportar e disparar e-mail — e para não escrever nada.
   ========================================================================== */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;
const CAMP = amb.SEMEADOS.campeonatoFutebol;

/* Um documento qualquer, para exercitar a conferência (que é só do master). */
const umDocumento = () => db.valor('SELECT id FROM documentos LIMIT 1');

describe('permissões', () => {
  /* ------------------------------------------------------------------------
     SEM SESSÃO
     ------------------------------------------------------------------------ */

  it('sem sessão, toda rota de painel devolve 401', async () => {
    const cli = amb.anonimo();

    const leituras = [
      '/api/times', '/api/times/t1', '/api/inscricoes', '/api/chamados',
      '/api/conta/sessoes', '/api/admin/metricas', '/api/admin/usuarios',
      '/api/auditoria', '/api/historico', '/api/email/modelos', '/api/email/smtp',
      '/api/ranking-config/futebol', '/api/posts?arquivados=1',
      `/api/campeonatos/${CAMP}/inscritos`, `/api/campeonatos/${CAMP}/exportar`
    ];

    for (const caminho of leituras) {
      const r = await cli.get(caminho);
      assert.equal(r.status, 401, `GET ${caminho} deveria pedir login`);
    }

    const escritas = [
      ['POST', '/api/times', { nome: 'X', modalidade: 'futebol' }],
      ['POST', '/api/inscricoes', { campeonatoId: CAMP, timeId: 't1' }],
      ['POST', '/api/chamados', { assunto: 'Assunto de teste', mensagem: 'mensagem' }],
      ['POST', '/api/campeonatos', { nome: 'X', modalidade: 'futebol' }],
      ['POST', '/api/posts', { titulo: 'X' }],
      ['PUT', '/api/ranking/futebol', { linhas: [] }]
    ];

    for (const [metodo, caminho, corpo] of escritas) {
      const r = await cli.pedir(metodo, caminho, corpo);
      assert.equal(r.status, 401, `${metodo} ${caminho} deveria pedir login`);
    }
  });

  /* ------------------------------------------------------------------------
     PAPEL ERRADO
     ------------------------------------------------------------------------ */

  it('competidor não entra em nenhuma rota de administração', async () => {
    const cli = amb.comoCompetidor();

    const proibidas = [
      ['GET', '/api/admin/metricas'],
      ['GET', '/api/admin/usuarios'],
      ['GET', '/api/auditoria'],
      ['GET', '/api/historico'],
      ['GET', '/api/email/modelos'],
      ['GET', `/api/campeonatos/${CAMP}/inscritos`],
      ['GET', `/api/campeonatos/${CAMP}/exportar`],
      ['POST', '/api/campeonatos', { nome: 'Copa do Competidor', modalidade: 'futebol' }],
      ['POST', '/api/posts', { titulo: 'Post do competidor' }],
      ['PUT', '/api/ranking/futebol', { linhas: [] }],
      ['POST', `/api/documentos/${umDocumento()}/conferir`, { status: 'aprovado' }]
    ];

    for (const [metodo, caminho, corpo] of proibidas) {
      const r = await cli.pedir(metodo, caminho, corpo);
      assert.equal(r.status, 403, `${metodo} ${caminho} deveria dar 403 ao competidor`);
    }
  });

  it('administrador não age como competidor', async () => {
    const cli = amb.comoMaster();

    const proibidas = [
      ['POST', '/api/times', { nome: 'Time do admin', modalidade: 'dance' }],
      ['PUT', '/api/times/t1', { nome: 'Renomeado pelo admin' }],
      ['DELETE', '/api/times/t1/jogadores/t1-j1', undefined],
      ['POST', '/api/inscricoes', { campeonatoId: CAMP, timeId: 't1' }],
      ['POST', '/api/chamados', { assunto: 'Chamado do admin', mensagem: 'texto' }]
    ];

    for (const [metodo, caminho, corpo] of proibidas) {
      const r = await cli.pedir(metodo, caminho, corpo);
      assert.equal(r.status, 403, `${metodo} ${caminho} deveria dar 403 ao admin`);
    }
  });

  /* ------------------------------------------------------------------------
     GESTOR: LÊ, MAS NÃO ESCREVE
     ------------------------------------------------------------------------ */

  it('o gestor lê campeonatos, inscritos, times, exportação e auditoria', async () => {
    const cli = amb.comoGestor();

    const leituras = [
      '/api/admin/metricas',
      '/api/times',
      '/api/inscricoes',
      '/api/chamados',
      '/api/auditoria',
      '/api/historico',
      '/api/email/modelos',
      '/api/email/enviados',
      `/api/campeonatos/${CAMP}`,
      `/api/campeonatos/${CAMP}/inscritos`,
      `/api/campeonatos/${CAMP}/exportar?lista=todas`
    ];

    for (const caminho of leituras) {
      const r = await cli.get(caminho);
      assert.equal(r.status, 200, `o gestor deveria ler ${caminho} — veio ${r.status}`);
    }
  });

  it('o gestor não escreve nada', async () => {
    const cli = amb.comoGestor();
    const inscricao = db.valor('SELECT id FROM inscricoes LIMIT 1');

    const escritas = [
      ['POST', '/api/campeonatos', { nome: 'Copa do Gestor', modalidade: 'futebol' }],
      ['PUT', `/api/campeonatos/${CAMP}`, { local: 'Outro lugar' }],
      ['POST', `/api/campeonatos/${CAMP}/status`, { status: 'fechado' }],
      ['POST', `/api/campeonatos/${CAMP}/apuracao`, { classificacao: [{ nome: 'A' }] }],
      ['DELETE', `/api/campeonatos/${CAMP}`, undefined],
      ['POST', `/api/inscricoes/${inscricao}/status`, { status: 'oficial' }],
      ['POST', '/api/posts', { titulo: 'Post do gestor', cat: 'Campeonatos' }],
      ['PUT', '/api/posts/p1', { titulo: 'Editado pelo gestor' }],
      ['DELETE', '/api/posts/p1', undefined],
      ['POST', '/api/banners', { titulo: 'X', img: 'a.svg' }],
      ['PUT', '/api/ranking/futebol', { linhas: [{ nome: 'X' }] }],
      ['PUT', '/api/email/smtp', { servidorSaida: 'mal.exemplo.com' }],
      ['PUT', '/api/email/modelos/conta-criada', { assunto: 'X' }],
      ['GET', '/api/admin/usuarios', undefined],
      ['POST', '/api/admin/usuarios', { nome: 'X', email: 'x@y.com', nivel: 'gestor' }],
      ['POST', `/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}/mensagens`, { texto: 'resposta do gestor' }],
      ['POST', `/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}/status`, { status: 'encerrado' }],
      ['DELETE', `/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}`, undefined],
      ['POST', `/api/documentos/${umDocumento()}/conferir`, { status: 'aprovado' }]
    ];

    for (const [metodo, caminho, corpo] of escritas) {
      const r = await cli.pedir(metodo, caminho, corpo);
      assert.equal(r.status, 403, `${metodo} ${caminho} deveria dar 403 ao gestor — veio ${r.status}`);
    }
  });

  it('nada do que o gestor tentou escrever chegou ao banco', () => {
    const campeonato = db.um('SELECT * FROM campeonatos WHERE id = ?', CAMP);
    assert.equal(campeonato.status, 'inscricoes');
    assert.notEqual(campeonato.local, 'Outro lugar');
    assert.equal(campeonato.arquivado_em, null);
    assert.equal(db.valor('SELECT COUNT(*) FROM posts WHERE titulo = ?', 'Post do gestor'), 0);
    assert.equal(db.valor('SELECT COUNT(*) FROM contas WHERE email = ?', 'x@y.com'), 0);
  });

  it('a operação responde chamado, mas não arquiva nem mexe em campeonato', async () => {
    const cli = amb.comoOperacao();

    const resposta = await cli.post(
      `/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}/mensagens`,
      { texto: 'Recebemos o seu pedido, vamos verificar.' }
    );
    assert.equal(resposta.status, 201);

    const arquiva = await cli.apagar(`/api/chamados/${amb.SEMEADOS.chamadoDoCompetidor}`);
    assert.equal(arquiva.status, 403);

    const publica = await cli.post(`/api/campeonatos/${CAMP}/status`, { status: 'fechado' });
    assert.equal(publica.status, 403);

    const usuarios = await cli.get('/api/admin/usuarios');
    assert.equal(usuarios.status, 403);
  });

  it('só o master lista e cria administradores', async () => {
    const lista = await amb.comoMaster().get('/api/admin/usuarios');
    assert.equal(lista.status, 200);
    assert.ok(lista.corpo.usuarios.length >= 3);
  });

  /* ------------------------------------------------------------------------
     VAZAMENTO DE CREDENCIAL
     ------------------------------------------------------------------------ */

  it('nenhuma resposta traz senha_hash, senha_salt ou senha em claro', async () => {
    const master = amb.comoMaster();
    const competidor = amb.comoCompetidor();

    const respostas = [];
    for (const caminho of [
      '/api/bootstrap', '/api/admin/usuarios', '/api/admin/metricas', '/api/auditoria',
      '/api/historico', '/api/email/smtp', '/api/email/modelos', '/api/email/enviados',
      '/api/times', '/api/inscricoes', '/api/chamados', '/api/conta/sessoes',
      `/api/campeonatos/${CAMP}/inscritos`, `/api/campeonatos/${CAMP}/exportar?lista=todas`
    ]) {
      respostas.push([caminho, await master.get(caminho)]);
    }
    for (const caminho of ['/api/bootstrap', '/api/times', '/api/auth/sessao', '/api/conta/sessoes']) {
      respostas.push([caminho, await competidor.get(caminho)]);
    }
    respostas.push(['/api/auth/login', await amb.cliente().post('/api/auth/login', {
      email: amb.CONTAS.master.email, senha: amb.SENHA_ADMIN
    })]);

    /* Os valores reais que estão no banco: procurar pelo nome da coluna pega o
       descuido óbvio, procurar pelo conteúdo pega o descuido criativo. */
    const segredos = db.todos('SELECT senha_hash, senha_salt FROM contas');

    for (const [caminho, r] of respostas) {
      assert.equal(r.status, 200, `${caminho} não respondeu`);
      assert.ok(!r.texto.includes('senha_hash'), `${caminho} devolveu a coluna senha_hash`);
      assert.ok(!r.texto.includes('senha_salt'), `${caminho} devolveu a coluna senha_salt`);

      for (const s of segredos) {
        assert.ok(!r.texto.includes(s.senha_hash), `${caminho} devolveu um hash de senha`);
        assert.ok(!r.texto.includes(s.senha_salt), `${caminho} devolveu um sal de senha`);
      }
      for (const clara of [amb.SENHA_ADMIN, amb.SENHA_COMPETIDOR]) {
        assert.ok(!r.texto.includes(clara), `${caminho} devolveu uma senha em claro`);
      }
    }
  });

  it('a lista de sessões não publica o token guardado', async () => {
    const cli = amb.comoCompetidor();
    const r = await cli.get('/api/conta/sessoes');

    assert.equal(r.status, 200);
    assert.ok(!r.texto.includes('token_hash'));

    const inteiros = db.todos('SELECT token_hash FROM sessoes');
    for (const s of inteiros) {
      assert.ok(!r.texto.includes(s.token_hash), 'saiu o token_hash inteiro');
    }
    /* Só o prefixo de 16 hexas, que serve para revogar e não para assumir. */
    assert.ok(r.corpo.sessoes.every((s) => /^[0-9a-f]{16}$/.test(s.id)));
  });

  it('um competidor não revoga a sessão de outro', async () => {
    const alvo = amb.novoCompetidor('Dono da Sessao');
    const intruso = amb.novoCompetidor('Intruso');

    const doAlvo = await alvo.cliente.get('/api/conta/sessoes');
    const identificador = doAlvo.corpo.sessoes[0].id;

    const tentativa = await intruso.cliente.apagar(`/api/conta/sessoes/${identificador}`);
    assert.equal(tentativa.status, 400);

    /* A sessão do alvo continua de pé. */
    assert.equal((await alvo.cliente.get('/api/auth/sessao')).corpo.conta.id, alvo.id);
  });

  /* ------------------------------------------------------------------------
     INJEÇÃO DE SQL
     ------------------------------------------------------------------------ */

  it('SQL enviado como nome é gravado como texto, não executado', async () => {
    const dono = amb.novoCompetidor('Dono Curioso');
    const veneno = "Robert'); DROP TABLE times;--";

    const antes = db.valor('SELECT COUNT(*) FROM times');
    const criado = await dono.cliente.post('/api/times', {
      nome: veneno, modalidade: 'basquete'
    });

    assert.equal(criado.status, 201);
    assert.equal(criado.corpo.time.nome, veneno);

    /* A tabela continua lá e o texto foi gravado tal e qual. */
    assert.equal(db.valor('SELECT COUNT(*) FROM times'), antes + 1);
    assert.equal(db.valor('SELECT nome FROM times WHERE id = ?', criado.corpo.time.id), veneno);

    const lido = await dono.cliente.get(`/api/times/${criado.corpo.time.id}`);
    assert.equal(lido.corpo.time.nome, veneno);
  });

  it('SQL num filtro de busca não passa da validação', async () => {
    const master = amb.comoMaster();

    /* Codificado como o navegador codificaria — o servidor decodifica e
       precisa recusar pelo conteúdo, não por acidente de formato. */
    const status = await master.get(
      `/api/inscricoes?status=${encodeURIComponent("' OR 1=1 --")}`
    );
    assert.equal(status.status, 400);

    const doCampeonato = await master.get(
      `/api/campeonatos?status=${encodeURIComponent("x' UNION SELECT 1 --")}`
    );
    assert.equal(doCampeonato.status, 400);

    /* O nome da tabela do histórico é a única entrada que vira identificador de
       SQL; a lista branca é o que impede tudo. */
    const tabela = await master.post('/api/historico/restaurar', {
      tabela: 'contas WHERE 1=1; DROP TABLE contas; --', id: 'x'
    });
    assert.equal(tabela.status, 400);

    const prototipo = await master.post('/api/historico/restaurar', { tabela: 'constructor', id: 'x' });
    assert.equal(prototipo.status, 400);

    assert.ok(db.valor('SELECT COUNT(*) FROM contas') > 0, 'a tabela contas sobreviveu');
    assert.ok(db.valor('SELECT COUNT(*) FROM campeonatos') > 0);
  });

  it('SQL no corpo de um chamado é gravado e devolvido escapado', async () => {
    const dono = amb.novoCompetidor('Autor do Chamado');
    const veneno = "'; DELETE FROM chamados; -- <script>alert(1)</script>";

    const aberto = await dono.cliente.post('/api/chamados', {
      assunto: 'Teste de injeção no chamado',
      mensagem: veneno
    });

    assert.equal(aberto.status, 201);
    assert.ok(db.valor('SELECT COUNT(*) FROM chamados') > 1, 'a tabela chamados sobreviveu');

    const gravada = db.valor(
      `SELECT texto FROM chamado_mensagens
        WHERE chamado_id = (SELECT id FROM chamados WHERE protocolo = ?) AND de = 'usuario'`,
      aberto.corpo.chamado.protocolo
    );
    assert.equal(gravada, veneno);

    /* No e-mail o mesmo texto sai escapado: o histórico do admin imprime a
       prévia com innerHTML. */
    const email = db.um(
      "SELECT * FROM emails_enviados WHERE modelo_id = 'chamado-aberto' ORDER BY data DESC, rowid DESC LIMIT 1"
    );
    assert.ok(!email.corpo.includes('<script>'), 'o e-mail saiu com HTML cru do usuário');
  });
});
