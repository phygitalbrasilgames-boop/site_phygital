/* ==========================================================================
   IDIOMAS — resolução da requisição, conteúdo cadastrado, e-mail e mensagens

   O cliente pediu o site e os painéis em português, inglês e espanhol, com o
   conteúdo cadastrado traduzido junto — não só a interface.

   O que precisa ficar provado aqui:

     · as quatro fontes de idioma, na ordem certa (?lang → cookie → conta →
       Accept-Language), e o 'pt' no fim da fila;
     · idioma desconhecido não derruba nada nem "meio traduz": cai em pt;
     · o FALLBACK campo a campo — meia tradução tem que virar meia tela em
       português, jamais tela vazia;
     · o conteúdo cadastrado saindo traduzido em /api/bootstrap?lang=en.

   Roda depois de 09 e 11 porque cria e apaga tradução de registros semeados;
   nenhum outro arquivo lê a tabela `traducoes`.
   ========================================================================== */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;
const traducoes = amb.traducoes;

/* Ids semeados que este arquivo usa como ponto fixo. cbf-2026 vem traduzido por
   inteiro; cbb-2026 só tem o nome em inglês — é o que prova o fallback. */
const CAMPEONATO = amb.SEMEADOS.campeonatoFutebol;
const CAMPEONATO_PARCIAL = amb.SEMEADOS.campeonatoBasquete;
const POST = 'p1';

const campeonatoDe = (corpo, id) => corpo.dados.campeonatos.find((c) => c.id === id);

describe('idiomas', () => {
  let mestre;

  before(() => { mestre = amb.comoMaster(); });

  /* ------------------------------------------------------------------------
     RESOLUÇÃO DO IDIOMA DA REQUISIÇÃO
     ------------------------------------------------------------------------ */

  it('o parâmetro ?lang decide, e vale para qualquer visitante', async () => {
    const r = await amb.anonimo().get('/api/bootstrap?lang=es');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.idioma, 'es');
    assert.deepEqual(r.corpo.idiomas, ['pt', 'en', 'es']);
  });

  it('sem nenhuma pista, o idioma é português', async () => {
    const r = await amb.anonimo().get('/api/bootstrap');
    assert.equal(r.corpo.idioma, 'pt');
  });

  it('o cookie vale quando não há ?lang, e o ?lang passa na frente dele', async () => {
    const visitante = amb.cliente();
    visitante.cookie = `${traducoes.NOME_COOKIE}=en`;

    assert.equal((await visitante.get('/api/bootstrap')).corpo.idioma, 'en');

    /* Escolha feita agora vence escolha anterior: é o que faz um link
       compartilhado abrir no idioma de quem compartilhou. */
    assert.equal((await visitante.get('/api/bootstrap?lang=es')).corpo.idioma, 'es');
  });

  it('a coluna da conta vale quando não há ?lang nem cookie', async () => {
    const dono = amb.novoCompetidor('Competidor Espanhol');

    /* Antes de escolher, a conta nasce em português. */
    assert.equal((await dono.cliente.get('/api/bootstrap')).corpo.idioma, 'pt');

    db.executar('UPDATE contas SET idioma = ? WHERE id = ?', 'es', dono.id);

    /* Cliente novo: o anterior guardou o cookie de idioma da requisição acima. */
    const semCookie = amb.sessao(dono.id);
    assert.equal((await semCookie.get('/api/bootstrap')).corpo.idioma, 'es');

    /* E o cookie continua tendo prioridade sobre a coluna. */
    semCookie.cookie += `; ${traducoes.NOME_COOKIE}=en`;
    assert.equal((await semCookie.get('/api/bootstrap')).corpo.idioma, 'en');
  });

  it('o Accept-Language é a última pista antes do português', async () => {
    const visitante = amb.anonimo();

    const r = await visitante.get('/api/bootstrap', {
      cabecalhos: { 'accept-language': 'fr-FR,fr;q=0.9,es-419;q=0.8,en;q=0.7' }
    });
    /* Francês não existe aqui; entre os que existem, o de maior q é o espanhol. */
    assert.equal(r.corpo.idioma, 'es');

    const soDesconhecido = await amb.anonimo().get('/api/bootstrap', {
      cabecalhos: { 'accept-language': 'fr-FR,de;q=0.9,*;q=0.5' }
    });
    assert.equal(soDesconhecido.corpo.idioma, 'pt');
  });

  it('idioma inválido cai em português em vez de derrubar a requisição', async () => {
    /* Russo foi cogitado e descartado pelo cliente: é entrada de fora como
       qualquer outra e não pode virar erro nem tela vazia. */
    for (const valor of ['ru', 'xx', 'pt-BR-nonsense-injection', '', '../../etc']) {
      const r = await amb.anonimo().get(`/api/bootstrap?lang=${encodeURIComponent(valor)}`);
      assert.equal(r.status, 200, `?lang=${valor} devia responder 200`);
      assert.equal(r.corpo.idioma, 'pt', `?lang=${valor} devia cair em pt`);
    }

    /* Cookie corrompido também é ignorado, não herdado. */
    const visitante = amb.cliente();
    visitante.cookie = `${traducoes.NOME_COOKIE}=klingon`;
    assert.equal((await visitante.get('/api/bootstrap')).corpo.idioma, 'pt');
  });

  it('variante regional é aceita e reduzida à língua', async () => {
    assert.equal((await amb.anonimo().get('/api/bootstrap?lang=pt-BR')).corpo.idioma, 'pt');
    assert.equal((await amb.anonimo().get('/api/bootstrap?lang=en-US')).corpo.idioma, 'en');
    assert.equal((await amb.anonimo().get('/api/bootstrap?lang=es-419')).corpo.idioma, 'es');
  });

  /* ------------------------------------------------------------------------
     PREFERÊNCIA GRAVADA NA CONTA
     ------------------------------------------------------------------------ */

  it('o competidor troca o idioma da conta e o cookie acompanha', async () => {
    const dono = amb.novoCompetidor('Competidor Bilíngue');

    const trocou = await dono.cliente.post('/api/conta/idioma', { idioma: 'en' });
    assert.equal(trocou.status, 200);
    assert.equal(trocou.corpo.idioma, 'en');
    assert.equal(trocou.corpo.conta.idioma, 'en');
    assert.equal(db.valor('SELECT idioma FROM contas WHERE id = ?', dono.id), 'en');

    /* O cookie tem prioridade sobre a coluna: se não viesse junto, esta mesma
       aba continuaria em português até o cookie antigo vencer. */
    assert.match(trocou.cookies.join('; '), new RegExp(`${traducoes.NOME_COOKIE}=en`));
    assert.match(dono.cliente.cookie, new RegExp(`${traducoes.NOME_COOKIE}=en`));

    /* E o cookie novo não pode ter derrubado o de sessão. */
    const depois = await dono.cliente.get('/api/bootstrap');
    assert.equal(depois.corpo.idioma, 'en');
    assert.equal(depois.corpo.conta.id, dono.id);
  });

  it('idioma fora da lista é recusado na conta, não gravado calado', async () => {
    const dono = amb.novoCompetidor('Competidor Teimoso');

    const recusado = await dono.cliente.post('/api/conta/idioma', { idioma: 'ru' });
    assert.equal(recusado.status, 400);
    assert.equal(db.valor('SELECT idioma FROM contas WHERE id = ?', dono.id), 'pt');

    assert.equal((await amb.anonimo().post('/api/conta/idioma', { idioma: 'en' })).status, 401);
  });

  /* ------------------------------------------------------------------------
     CONTEÚDO CADASTRADO
     ------------------------------------------------------------------------ */

  it('o bootstrap com ?lang=en devolve o conteúdo cadastrado em inglês', async () => {
    const emIngles = await amb.anonimo().get('/api/bootstrap?lang=en');
    const emPortugues = await amb.anonimo().get('/api/bootstrap');

    const camp = campeonatoDe(emIngles.corpo, CAMPEONATO);
    const original = campeonatoDe(emPortugues.corpo, CAMPEONATO);

    assert.equal(camp.nome, 'Phygital Football Cup 2026 — National Stage');
    assert.match(camp.descricao, /national calendar/);
    assert.match(camp.local, /Brazil/);
    assert.notEqual(camp.nome, original.nome);

    /* Só os campos traduzíveis mudam: o resto do objeto continua idêntico. */
    assert.equal(camp.id, original.id);
    assert.equal(camp.modalidade, original.modalidade);
    assert.equal(camp.vagas, original.vagas);
    assert.equal(camp.encerramentoInscricoes, original.encerramentoInscricoes);

    const post = emIngles.corpo.dados.posts.find((p) => p.id === POST);
    assert.match(post.titulo, /opens registration/);
    assert.match(post.resumo, /Games of the Future/);

    const categoria = emIngles.corpo.dados.categorias.find((c) => c.id === 'campeonatos');
    assert.equal(categoria.nome, 'Championships');
  });

  it('o espanhol sai do mesmo registro, sem vazar inglês', async () => {
    const r = await amb.anonimo().get('/api/bootstrap?lang=es');
    const camp = campeonatoDe(r.corpo, CAMPEONATO);

    assert.equal(camp.nome, 'Copa Phygital de Fútbol 2026 — Etapa Nacional');
    assert.match(camp.termos, /autorización de imagen/);
  });

  it('campo sem tradução volta em português — meia tradução não vira tela vazia', async () => {
    const emIngles = await amb.anonimo().get('/api/bootstrap?lang=en');
    const emPortugues = await amb.anonimo().get('/api/bootstrap');

    /* cbb-2026 tem só o nome em inglês. */
    const parcial = campeonatoDe(emIngles.corpo, CAMPEONATO_PARCIAL);
    const original = campeonatoDe(emPortugues.corpo, CAMPEONATO_PARCIAL);

    assert.equal(parcial.nome, 'Phygital 3x3 Basketball Circuit — 2nd Edition');
    assert.equal(parcial.descricao, original.descricao);
    assert.equal(parcial.termos, original.termos);
    assert.ok(parcial.descricao, 'a descrição não pode voltar vazia');

    /* E em espanhol, onde não há tradução nenhuma, tudo permanece em português. */
    const emEspanhol = await amb.anonimo().get('/api/bootstrap?lang=es');
    const semNada = campeonatoDe(emEspanhol.corpo, CAMPEONATO_PARCIAL);
    assert.deepEqual(semNada, original);

    /* O post p1 não tem `corpo` traduzido; o titulo tem. */
    const post = emIngles.corpo.dados.posts.find((p) => p.id === POST);
    const postOriginal = emPortugues.corpo.dados.posts.find((p) => p.id === POST);
    assert.notEqual(post.titulo, postOriginal.titulo);
    assert.equal(post.corpo, postOriginal.corpo);
  });

  it('registro sem nenhuma tradução sai idêntico ao português', async () => {
    const emIngles = await amb.anonimo().get('/api/bootstrap?lang=en');
    const emPortugues = await amb.anonimo().get('/api/bootstrap');

    const shooter = campeonatoDe(emIngles.corpo, amb.SEMEADOS.campeonatoShooter);
    assert.deepEqual(shooter, campeonatoDe(emPortugues.corpo, amb.SEMEADOS.campeonatoShooter));
  });

  it('as rotas dedicadas traduzem igual ao bootstrap', async () => {
    const detalhe = await amb.anonimo().get(`/api/campeonatos/${CAMPEONATO}?lang=en`);
    assert.equal(detalhe.corpo.campeonato.nome, 'Phygital Football Cup 2026 — National Stage');

    const lista = await amb.anonimo().get('/api/campeonatos?lang=es');
    const naLista = lista.corpo.campeonatos.find((c) => c.id === CAMPEONATO);
    assert.equal(naLista.nome, 'Copa Phygital de Fútbol 2026 — Etapa Nacional');

    const posts = await amb.anonimo().get('/api/posts?lang=en');
    assert.match(posts.corpo.posts.find((p) => p.id === POST).titulo, /opens registration/);
  });

  it('o administrador continua lendo o português, que é o que ele edita', async () => {
    /* O painel do admin é a superfície de edição: se o formulário nascesse com
       o inglês, o próximo "salvar" gravaria a tradução por cima do original. */
    const emIngles = await mestre.get(`/api/campeonatos/${CAMPEONATO}?lang=en`);
    assert.match(emIngles.corpo.campeonato.nome, /Etapa Nacional/);
    assert.match(emIngles.corpo.campeonato.local, /São Paulo, SP/);

    /* Mas a INTERFACE dele responde no idioma pedido — só o cadastro não. */
    const semSessao = await mestre.get('/api/bootstrap?lang=en');
    assert.equal(semSessao.corpo.idioma, 'en');
    assert.match(campeonatoDe(semSessao.corpo, CAMPEONATO).nome, /Etapa Nacional/);
  });

  /* ------------------------------------------------------------------------
     API DE TRADUÇÃO
     ------------------------------------------------------------------------ */

  it('a lista de campos traduzíveis vem do servidor, tabela por tabela', async () => {
    const r = await mestre.get('/api/traducoes/campos');

    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.idiomasTraduziveis, ['en', 'es']);
    assert.deepEqual(r.corpo.campos.campeonatos, ['nome', 'descricao', 'local', 'termos']);
    assert.deepEqual(r.corpo.campos.banners_site,
      ['titulo', 'texto', 'eyebrow', 'botao', 'botao2']);
    assert.deepEqual(r.corpo.campos.parceiros, ['tipo']);

    /* A tela do admin se monta a partir desta resposta; a constante é única. */
    assert.deepEqual(Object.keys(r.corpo.campos).sort(),
      [...traducoes.TABELAS_TRADUZIVEIS].sort());

    /* O resumo conta o que a semente traduziu, para a tela saber o que falta. */
    const campeonatosEn = r.corpo.resumo
      .find((l) => l.tabela === 'campeonatos' && l.idioma === 'en');
    assert.ok(campeonatosEn && campeonatosEn.total > 0);
  });

  it('o admin grava, lê e apaga a tradução de um registro', async () => {
    const gravado = await mestre.put('/api/traducoes', {
      tabela: 'eventos',
      registro: 'e1',
      traducoes: {
        en: { titulo: 'National Final 2025' },
        es: { titulo: 'Final Nacional 2025', local: 'Recife, Brasil' }
      }
    });

    assert.equal(gravado.status, 200);
    assert.equal(gravado.corpo.gravados, 3);
    assert.equal(gravado.corpo.traducoes.en.titulo, 'National Final 2025');
    /* Campo sem tradução vem vazio para o formulário nascer completo. */
    assert.equal(gravado.corpo.traducoes.en.local, '');

    const lido = await mestre.get('/api/traducoes?tabela=eventos&registro=e1');
    assert.equal(lido.status, 200);
    assert.equal(lido.corpo.traducoes.es.local, 'Recife, Brasil');
    /* O português vem junto, para o tradutor ver o que está traduzindo. */
    assert.ok(lido.corpo.original.titulo);

    const noSite = await amb.anonimo().get('/api/bootstrap?lang=en');
    assert.equal(noSite.corpo.dados.eventos.find((e) => e.id === 'e1').titulo,
      'National Final 2025');

    /* Texto vazio devolve o campo ao português em vez de gravar ''. */
    const apagado = await mestre.put('/api/traducoes', {
      tabela: 'eventos', registro: 'e1', idioma: 'en', campo: 'titulo', texto: '   '
    });
    assert.equal(apagado.corpo.apagados, 1);
    assert.equal(apagado.corpo.traducoes.en.titulo, '');
    assert.equal(
      db.valor("SELECT COUNT(*) FROM traducoes WHERE registro_id = 'e1' AND idioma = 'en'"), 0
    );

    const voltou = await amb.anonimo().get('/api/bootstrap?lang=en');
    const original = await amb.anonimo().get('/api/bootstrap');
    assert.equal(
      voltou.corpo.dados.eventos.find((e) => e.id === 'e1').titulo,
      original.corpo.dados.eventos.find((e) => e.id === 'e1').titulo
    );

    db.executar("DELETE FROM traducoes WHERE tabela = 'eventos' AND registro_id = 'e1'");
  });

  it('a tradução recusa tabela, campo, idioma e registro que não existem', async () => {
    const casos = [
      [{ tabela: 'contas', registro: 'u1', idioma: 'en', campo: 'nome', texto: 'x' }, 400],
      [{ tabela: 'posts', registro: POST, idioma: 'en', campo: 'senha_hash', texto: 'x' }, 400],
      [{ tabela: 'posts', registro: POST, idioma: 'ru', campo: 'titulo', texto: 'x' }, 400],
      /* pt é a língua de origem: mora na tabela de negócio, não aqui. */
      [{ tabela: 'posts', registro: POST, idioma: 'pt', campo: 'titulo', texto: 'x' }, 400],
      [{ tabela: 'posts', registro: 'nao-existe', idioma: 'en', campo: 'titulo', texto: 'x' }, 404],
      [{ tabela: 'posts', registro: POST }, 400]
    ];

    for (const [corpo, esperado] of casos) {
      const r = await mestre.put('/api/traducoes', corpo);
      assert.equal(r.status, esperado, `${JSON.stringify(corpo)} → ${r.status} ${r.texto}`);
    }
  });

  it('traduzir exige a permissão de escrita da própria área', async () => {
    /* gestor lê campeonato e exporta, mas não escreve — nem em português nem
       em inglês. */
    const gestor = amb.comoGestor();
    const negado = await gestor.put('/api/traducoes', {
      tabela: 'campeonatos', registro: CAMPEONATO, idioma: 'en', campo: 'nome', texto: 'Cup'
    });
    assert.equal(negado.status, 403);

    assert.equal((await amb.comoCompetidor().get('/api/traducoes/campos')).status, 403);
    assert.equal((await amb.anonimo().get(
      `/api/traducoes?tabela=posts&registro=${POST}`)).status, 401);

    /* O nome em português continua intacto depois da recusa. */
    assert.match(
      db.valor('SELECT nome FROM campeonatos WHERE id = ?', CAMPEONATO), /Etapa Nacional/
    );
  });

  it('a tradução fica registrada na auditoria', async () => {
    await mestre.put('/api/traducoes', {
      tabela: 'parceiros', registro: 'pa1', traducoes: { en: { tipo: 'Official sponsor' } }
    });

    const registro = amb.ultimaAuditoria('configuracao');
    assert.match(registro.acao, /traduziu/);
    assert.match(registro.detalhe, /en/);

    db.executar("DELETE FROM traducoes WHERE tabela = 'parceiros' AND registro_id = 'pa1'");
  });

  /* ------------------------------------------------------------------------
     MENSAGENS DE ERRO DA API
     ------------------------------------------------------------------------ */

  it('a mensagem de erro sai no idioma da requisição', async () => {
    const semSessao = await amb.anonimo().get('/api/conta/sessoes?lang=en');
    assert.equal(semSessao.status, 401);
    assert.equal(semSessao.corpo.erro, 'Sign in to continue.');

    const emEspanhol = await amb.anonimo().get('/api/conta/sessoes?lang=es');
    assert.equal(emEspanhol.corpo.erro, 'Inicia sesión para continuar.');

    /* Em português continua exatamente como antes. */
    assert.equal((await amb.anonimo().get('/api/conta/sessoes')).corpo.erro,
      'Faça login para continuar.');
  });

  it('a mensagem com valor no meio mantém o valor ao ser traduzida', async () => {
    const r = await amb.comoCompetidor().post('/api/inscricoes?lang=en', { campeonatoId: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.corpo.erro, 'Provide the championship (campeonatoId) and the team (timeId).');

    const semTime = await amb.comoCompetidor().post('/api/inscricoes?lang=es', {
      campeonatoId: CAMPEONATO, timeId: 'time-que-nao-existe'
    });
    assert.equal(semTime.corpo.erro, 'Equipo no encontrado.');
  });

  it('mensagem ainda não traduzida volta em português em vez de sumir', async () => {
    /* A cobertura é parcial de propósito. O que não está no dicionário tem que
       atravessar inteiro — nunca virar string vazia nem 'undefined'. */
    const emIngles = amb.mensagens.traduzir('Uma mensagem que ninguém traduziu ainda.', 'en');
    assert.equal(emIngles, 'Uma mensagem que ninguém traduziu ainda.');

    const r = await amb.comoCompetidor().apagar('/api/times/nao-existe?lang=en');
    assert.equal(r.status, 404);
    assert.ok(r.corpo.erro && r.corpo.erro.length > 3);
  });

  /* ------------------------------------------------------------------------
     E-MAIL
     ------------------------------------------------------------------------ */

  it('o e-mail sai no idioma da conta que vai recebê-lo', async () => {
    const dono = amb.novoCompetidor('Destinatário Espanhol');
    db.executar('UPDATE contas SET idioma = ? WHERE id = ?', 'es', dono.id);

    const correio = require(`${amb.RAIZ}/server/email`);

    const enviado = correio.enviar({
      modeloId: 'codigo-verificacao',
      para: dono.email,
      contexto: { codigo: '123456', usuario: { nome: dono.nome } }
    });

    assert.equal(enviado.idioma, 'es');
    assert.equal(enviado.assunto, 'Tu código de verificación es 123456');
    assert.match(enviado.corpo, /código de verificación/);

    /* A mesma mensagem, para quem não escolheu idioma, continua em português. */
    const outro = amb.novoCompetidor('Destinatário Brasileiro');
    const emPortugues = correio.enviar({
      modeloId: 'codigo-verificacao',
      para: outro.email,
      contexto: { codigo: '654321', usuario: { nome: outro.nome } }
    });

    assert.equal(emPortugues.idioma, 'pt');
    assert.equal(emPortugues.assunto, 'Seu código de verificação é 654321');
  });

  it('modelo sem tradução no idioma do destinatário volta em português', async () => {
    const dono = amb.novoCompetidor('Destinatário Inglês');
    db.executar('UPDATE contas SET idioma = ? WHERE id = ?', 'en', dono.id);

    const correio = require(`${amb.RAIZ}/server/email`);

    /* 'conta-criada' não foi traduzido pela semente. */
    const enviado = correio.enviar({
      modeloId: 'conta-criada',
      para: dono.email,
      contexto: { usuario: { nome: dono.nome, email: dono.email } }
    });

    assert.equal(enviado.idioma, 'en');
    assert.match(enviado.assunto, /Bem-vindo à Phygital Brasil/);
    assert.ok(enviado.ok, 'o envio não pode falhar por falta de tradução');
  });

  it('o código de verificação chega no idioma da conta', async () => {
    /* rotas/auth.js grava direto em emails_enviados, sem passar por email.js —
       o caminho paralelo precisa escolher o idioma sozinho, e é justamente o
       e-mail que o competidor estrangeiro recebe primeiro. */
    const dono = amb.novoCompetidor('Competidor Que Verifica');

    const pedir = async () => {
      const r = await dono.cliente.post('/api/conta/dados', { nome: 'Competidor Que Verifica' });
      assert.equal(r.status, 200);
      return db.um(
        'SELECT assunto, corpo FROM emails_enviados WHERE destino = ? ORDER BY data DESC, id DESC LIMIT 1',
        dono.email
      );
    };

    assert.match((await pedir()).assunto, /Seu código de verificação/);

    assert.equal((await dono.cliente.post('/api/conta/idioma', { idioma: 'en' })).status, 200);
    const emIngles = await pedir();
    assert.match(emIngles.assunto, /Your verification code is \d{6}/);
    assert.match(emIngles.corpo, /valid for 15 minutes/);

    assert.equal((await dono.cliente.post('/api/conta/idioma', { idioma: 'es' })).status, 200);
    assert.match((await pedir()).assunto, /Tu código de verificación/);
  });

  it('endereço que não é de nenhuma conta cai no português', async () => {
    const correio = require(`${amb.RAIZ}/server/email`);
    assert.equal(correio.idiomaDoDestinatario(['ninguem@exemplo.com']), 'pt');
    assert.equal(correio.idiomaDoDestinatario([]), 'pt');
  });

  /* ------------------------------------------------------------------------
     DICIONÁRIO DA INTERFACE

     site/assets/i18n/*.json é gerado por ferramentas/extrair-textos.js e vive
     no repositório. A chave é o próprio texto em português, então uma chave é
     uma regra de reescrita GLOBAL: se um nome de time virar chave, o runtime o
     traduz em qualquer tela em que ele apareça — inclusive na sessão do admin,
     que server/http.js protege devolvendo o conteúdo sempre em português.

     O extrator tem uma guarda que apaga essas chaves. Estes testes provam que
     a guarda rodou no arquivo que está commitado: sem eles, alguém regenera o
     dicionário com a guarda desligada (--sem-banco) e ninguém percebe.
     ------------------------------------------------------------------------ */

  const dicionario = () => {
    const bruto = require('node:fs').readFileSync(`${amb.RAIZ}/site/assets/i18n/pt.json`, 'utf8');
    return JSON.parse(bruto);
  };

  /* A MESMA normalização do extrator e do runtime. Se as três divergirem, a
     comparação aqui deixa de valer. */
  const normalizar = (texto) => String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();

  const chavesDoDicionario = () => {
    const pt = dicionario();
    return new Set(Object.keys(pt.textos).concat(Object.keys(pt.padroes)).map(normalizar));
  };

  /** Valores de uma coluna que o dicionário não pode conter. */
  const valoresDe = (tabela, coluna) => db.todos(`SELECT ${coluna} AS v FROM ${tabela}`)
    .map((l) => normalizar(l.v))
    .filter((v) => v && /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(v));

  it('o dicionário não traduz campo traduzível de conteúdo cadastrado', () => {
    const chaves = chavesDoDicionario();
    const colisoes = [];

    for (const tabela of Object.keys(traducoes.CAMPOS_TRADUZIVEIS)) {
      for (const campo of traducoes.CAMPOS_TRADUZIVEIS[tabela]) {
        for (const valor of valoresDe(tabela, campo)) {
          if (chaves.has(valor)) colisoes.push(`${tabela}.${campo}: ${valor}`);
        }
      }
    }

    assert.deepEqual(colisoes, [], 'chave do dicionário sobrescreveria conteúdo do banco');
  });

  it('o dicionário não traduz nome de time, de pessoa nem linha de ranking', () => {
    const chaves = chavesDoDicionario();
    const colisoes = [];

    /* Nome próprio não tem tradução em idioma nenhum: nem pelo dicionário da
       interface, nem pela tela de tradução do admin. */
    const colunas = [
      ['times', 'nome'], ['jogadores', 'nome'], ['jogadores', 'apelido'],
      ['staff', 'nome'], ['contas', 'nome'], ['ranking', 'nome']
    ];

    for (const [tabela, coluna] of colunas) {
      for (const valor of valoresDe(tabela, coluna)) {
        if (chaves.has(valor)) colisoes.push(`${tabela}.${coluna}: ${valor}`);
      }
    }

    assert.deepEqual(colisoes, [], 'chave do dicionário sobrescreveria nome cadastrado');
  });

  it('os três dicionários têm exatamente as mesmas chaves', () => {
    const ler = (idioma) => {
      const bruto = require('node:fs').readFileSync(`${amb.RAIZ}/site/assets/i18n/${idioma}.json`, 'utf8');
      const pacote = JSON.parse(bruto);
      return {
        textos: Object.keys(pacote.textos).sort(),
        padroes: Object.keys(pacote.padroes).sort()
      };
    };

    const pt = ler('pt');
    /* Chave a menos em en.json é trecho que nunca chega a ser traduzido, e
       chave a mais é chave que o runtime nunca procura: nos dois casos o
       arquivo saiu de uma extração diferente da que gerou o pt.json. */
    for (const idioma of ['en', 'es']) {
      assert.deepEqual(ler(idioma), pt, `${idioma}.json não casa com pt.json`);
    }
  });

  /* ------------------------------------------------------------------------
     BANCO
     ------------------------------------------------------------------------ */

  it('a coluna idioma e a tabela traducoes existem com a forma esperada', () => {
    const colunas = db.todos('PRAGMA table_info(contas)').map((c) => c.name);
    assert.ok(colunas.includes('idioma'), 'contas.idioma não existe');
    assert.equal(db.valor("SELECT COUNT(*) FROM contas WHERE idioma IS NULL"), 0);

    /* A chave primária composta é o que impede duas traduções do mesmo campo. */
    const chave = db.todos('PRAGMA table_info(traducoes)')
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    assert.deepEqual(chave, ['tabela', 'registro_id', 'campo', 'idioma']);

    assert.throws(() => db.executar(
      `INSERT INTO traducoes (tabela, registro_id, campo, idioma, texto, atualizado_em)
       VALUES ('posts', ?, 'titulo', 'en', 'duplicata', ?)`, POST, db.agora()
    ), /UNIQUE|constraint/i);
  });

  after(() => {
    /* Não deixa tradução de teste para os outros arquivos, que rodam antes mas
       compartilham o mesmo banco. */
    db.executar("DELETE FROM traducoes WHERE tabela IN ('eventos', 'parceiros')");
  });
});
