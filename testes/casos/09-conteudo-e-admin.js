/* ==========================================================================
   CONTEÚDO E ADMINISTRAÇÃO — CMS, usuários, auditoria, histórico e e-mail

   O que sobra do painel do administrador: blog e banners do site, cadastro de
   quem opera a plataforma, a trilha de auditoria e a lixeira com restauração.

   Este arquivo roda por último de propósito: ele arquiva e exclui registros, e
   fazer isso antes contaminaria as contagens dos outros.
   ========================================================================== */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;

describe('conteúdo e administração', () => {
  let mestre;

  before(() => { mestre = amb.comoMaster(); });

  /* ------------------------------------------------------------------------
     BLOG
     ------------------------------------------------------------------------ */

  it('o rascunho fica fora do site e aparece para o administrador', async () => {
    const criado = await mestre.post('/api/posts', {
      titulo: 'Etapa Norte confirmada', cat: 'Campeonatos',
      autor: 'Redação', resumo: 'texto do resumo', rascunho: true
    });

    assert.equal(criado.status, 200);
    const post = criado.corpo.post;
    assert.equal(post.rascunho, true);

    const publico = await amb.anonimo().get('/api/posts');
    assert.ok(!publico.corpo.posts.some((p) => p.id === post.id));
    assert.equal((await amb.anonimo().get(`/api/posts/${post.id}`)).status, 401);

    const doAdmin = await mestre.get('/api/posts?tudo=1');
    assert.ok(doAdmin.corpo.posts.some((p) => p.id === post.id));

    const publicado = await mestre.put(`/api/posts/${post.id}`, { publicado: true });
    assert.equal(publicado.corpo.post.publicado, true);
    assert.equal(publicado.corpo.post.titulo, 'Etapa Norte confirmada');

    const agoraSim = await amb.anonimo().get('/api/posts');
    assert.ok(agoraSim.corpo.posts.some((p) => p.id === post.id));
  });

  it('post e categoria são arquivados, não apagados, e voltam pelo histórico', async () => {
    const criado = await mestre.post('/api/posts', {
      titulo: 'Post que vai para a lixeira', cat: 'Campeonatos'
    });
    const id = criado.corpo.post.id;

    const arquivado = await mestre.apagar(`/api/posts/${id}`);
    assert.equal(arquivado.status, 200);
    assert.equal(arquivado.corpo.post.arquivado, true);
    assert.equal((await mestre.apagar(`/api/posts/${id}`)).status, 409);

    const historico = await mestre.get('/api/posts?arquivados=1');
    assert.ok(historico.corpo.posts.some((p) => p.id === id));

    /* A linha continua no banco — arquivar é marcar a data, não apagar. */
    assert.ok(db.um('SELECT id FROM posts WHERE id = ?', id));

    const restaurado = await mestre.post('/api/historico/restaurar', { tabela: 'posts', id });
    assert.equal(restaurado.status, 200);
    assert.equal(db.valor('SELECT arquivado_em FROM posts WHERE id = ?', id), null);
  });

  it('categoria com post não some, e o slug sai do nome', async () => {
    const comPosts = await mestre.apagar('/api/categorias/campeonatos');
    assert.equal(comPosts.status, 409);
    assert.ok(comPosts.corpo.posts > 0);

    const repetida = await mestre.post('/api/categorias', { nome: 'Campeonatos' });
    assert.equal(repetida.status, 409);

    const nova = await mestre.post('/api/categorias', { nome: 'Bastidores & Ação', cor: '#009b4a' });
    assert.equal(nova.corpo.categoria.id, 'bastidores-acao');

    const corTorta = await mestre.post('/api/categorias', { nome: 'Cor Ruim', cor: 'verde' });
    assert.equal(corTorta.status, 400);

    assert.equal((await mestre.apagar('/api/categorias/bastidores-acao')).status, 200);
  });

  /* ------------------------------------------------------------------------
     BANNERS
     ------------------------------------------------------------------------ */

  it('o banner recusa link javascript: e imagem ausente', async () => {
    const semImagem = await mestre.post('/api/banners', { titulo: 'Sem imagem' });
    assert.equal(semImagem.status, 400);

    const linkPerigoso = await mestre.post('/api/banners', {
      titulo: 'Novo', img: 'assets/img/mock/camp-dance.svg', link: 'javascript:alert(1)'
    });
    assert.equal(linkPerigoso.status, 400);

    const inativo = await mestre.post('/api/banners', {
      titulo: 'Banner Inativo', img: 'assets/img/mock/camp-dance.svg',
      link: 'inscricoes.html', ativo: false
    });
    assert.equal(inativo.status, 200);
    assert.equal(inativo.corpo.banner.ativo, false);

    const publico = await amb.anonimo().get('/api/banners');
    assert.ok(!publico.corpo.banners.some((b) => b.id === inativo.corpo.banner.id));
  });

  it('o banner do site troca de posição em vez de recusar, e renumera na reordenação', async () => {
    /* Pedir uma posição ocupada TROCA os dois de lugar. Recusar com 409
       quebrava as setas de admin/banners-site.html, que expressam a troca como
       dois PUT sequenciais: o primeiro colidia com o vizinho e derrubava tudo.
       O que precisa continuar valendo é a unicidade ao fim da operação. */
    const antes = await mestre.get('/api/banners-site');
    const ocupante = antes.corpo.bannersSite.find((b) => b.ordem === 2);
    assert.ok(ocupante, 'a semente precisa ter um banner na posição 2');

    const colide = await mestre.post('/api/banners-site', {
      titulo: 'Colide', img: 'a.svg', ordem: 2
    });
    assert.equal(colide.status, 200);
    assert.equal(colide.corpo.bannerSite.ordem, 2);

    const depois = await mestre.get('/api/banners-site');
    const ordens = depois.corpo.bannersSite.map((b) => b.ordem);
    assert.equal(new Set(ordens).size, ordens.length, 'nenhuma posição pode ficar duplicada');
    assert.notEqual(
      depois.corpo.bannersSite.find((b) => b.id === ocupante.id).ordem, 2,
      'o antigo ocupante precisa ter cedido a posição'
    );

    const videoSemArquivo = await mestre.post('/api/banners-site', {
      titulo: 'Sem mídia', midia: 'video'
    });
    assert.equal(videoSemArquivo.status, 400);

    const heroSemTexto = await mestre.post('/api/banners-site', { midia: 'imagem', img: 'a.svg' });
    assert.equal(heroSemTexto.status, 400);

    const criado = await mestre.post('/api/banners-site', {
      midia: 'video', video: 'https://cdn.exemplo.com/hero.mp4',
      titulo: 'Abertura 2026', eyebrow: 'Novo'
    });
    assert.equal(criado.status, 200);
    const hero = criado.corpo.bannerSite;

    const reordenado = await mestre.post(`/api/banners-site/${hero.id}/ordem`, { ordem: 1 });
    assert.equal(reordenado.corpo.bannersSite[0].id, hero.id);
    /* A ordem sai sempre 1..N, sem buraco. */
    assert.deepEqual(
      reordenado.corpo.bannersSite.map((b) => b.ordem),
      reordenado.corpo.bannersSite.map((_, i) => i + 1)
    );

    const noFim = await mestre.post(`/api/banners-site/${hero.id}/ordem`, { ordem: 99 });
    assert.equal(noFim.corpo.bannersSite.at(-1).id, hero.id);
  });

  it('o vídeo do banner aceita "youtube:<id>" e recusa identificador torto', async () => {
    /* O editor grava o vídeo do YouTube como um texto só, sem coluna nova. Como
       esse valor vira o src de um <iframe> na home, o identificador é conferido
       byte a byte: 11 caracteres do alfabeto do YouTube, nada além disso. */
    const doYoutube = await mestre.post('/api/banners-site', {
      titulo: 'Abertura no YouTube', midia: 'video', video: 'youtube:dQw4w9WgXcQ'
    });
    assert.equal(doYoutube.status, 200);
    assert.equal(doYoutube.corpo.bannerSite.video, 'youtube:dQw4w9WgXcQ');

    for (const torto of ['youtube:curto', 'youtube:dQw4w9WgXcQ&a=1', 'youtube:', 'youtube:../../etc']) {
      const recusado = await mestre.post('/api/banners-site', {
        titulo: 'Torto', midia: 'video', video: torto
      });
      assert.equal(recusado.status, 400, `deveria recusar ${torto}`);
    }

    /* O endereço comum de vídeo continua passando pela regra de sempre. */
    const arquivoEnviado = await mestre.put(`/api/banners-site/${doYoutube.corpo.bannerSite.id}`, {
      video: 'assets/enviados/9f1c2b3a-0000-4000-8000-000000000000.mp4'
    });
    assert.equal(arquivoEnviado.status, 200);

    const esquemaProibido = await mestre.put(`/api/banners-site/${doYoutube.corpo.bannerSite.id}`, {
      video: 'javascript:alert(1)'
    });
    assert.equal(esquemaProibido.status, 400);
  });

  it('evento e parceiro validam modalidade e recebem a próxima ordem', async () => {
    const modalidadeTorta = await mestre.post('/api/eventos', {
      titulo: 'Etapa de Xadrez', mod: 'xadrez', ano: 2026
    });
    assert.equal(modalidadeTorta.status, 400);

    const evento = await mestre.post('/api/eventos', {
      titulo: 'Etapa de Teste', mod: 'futebol', ano: 2026, fotos: 3
    });
    assert.equal(evento.status, 200);

    const parcial = await mestre.put(`/api/eventos/${evento.corpo.evento.id}`, { fotos: 9 });
    assert.equal(parcial.corpo.evento.titulo, 'Etapa de Teste');
    assert.equal(parcial.corpo.evento.fotos, 9);

    const quantos = db.valor('SELECT COUNT(*) FROM parceiros WHERE arquivado_em IS NULL');
    const parceiro = await mestre.post('/api/parceiros', { nome: 'Nova Marca' });
    assert.equal(parceiro.corpo.parceiro.ordem, quantos + 1);

    assert.equal((await amb.anonimo().get('/api/eventos/nao-existe')).status, 404);
  });

  /* ------------------------------------------------------------------------
     USUÁRIOS DA ADMINISTRAÇÃO
     ------------------------------------------------------------------------ */

  it('o novo administrador recebe senha temporária e cai no primeiro acesso', async () => {
    const r = await mestre.post('/api/admin/usuarios', {
      nome: 'Rita de Teste', email: 'rita.teste@phygitalgamesbr.com.br',
      telefone: '(11) 90000-0000', nivel: 'operacao'
    });

    assert.equal(r.status, 200);
    assert.equal(typeof r.corpo.senhaTemporaria, 'string');
    assert.equal(r.corpo.usuario.senhaProvisoria, true);
    /* O e-mail dele ainda não foi confirmado: o briefing manda passar pelo
       código antes de liberar o painel. */
    assert.equal(r.corpo.usuario.emailVerificado, false);

    const entrada = await amb.cliente().post('/api/auth/login', {
      email: 'rita.teste@phygitalgamesbr.com.br', senha: r.corpo.senhaTemporaria
    });
    assert.equal(entrada.status, 200);
    assert.equal(entrada.corpo.precisaTrocarSenha, true);
    assert.equal(entrada.corpo.precisaVerificarEmail, true);
  });

  it('e-mail repetido, e-mail inválido e nível inventado são recusados', async () => {
    const repetido = await mestre.post('/api/admin/usuarios', {
      nome: 'Outra', email: 'RITA.TESTE@phygitalgamesbr.com.br', nivel: 'gestor'
    });
    assert.equal(repetido.status, 409);

    const invalido = await mestre.post('/api/admin/usuarios', {
      nome: 'X', email: 'nao-e-email', nivel: 'gestor'
    });
    assert.equal(invalido.status, 400);

    const nivel = await mestre.post('/api/admin/usuarios', {
      nome: 'X', email: 'chefao@exemplo.com', nivel: 'chefao'
    });
    assert.equal(nivel.status, 400);
  });

  it('o master não se rebaixa nem se remove', async () => {
    const rebaixar = await mestre.put(`/api/admin/usuarios/${amb.CONTAS.master.id}`, {
      nivel: 'gestor'
    });
    assert.equal(rebaixar.status, 409);

    const remover = await mestre.apagar(`/api/admin/usuarios/${amb.CONTAS.master.id}`);
    assert.equal(remover.status, 409);

    assert.equal(db.valor('SELECT nivel FROM contas WHERE id = ?', amb.CONTAS.master.id), 'master');
    assert.equal(db.valor('SELECT arquivado_em FROM contas WHERE id = ?', amb.CONTAS.master.id), null);
  });

  it('remover um administrador derruba a sessão dele na hora', async () => {
    const criado = await mestre.post('/api/admin/usuarios', {
      nome: 'Efêmero de Teste', email: 'efemero.teste@phygitalgamesbr.com.br', nivel: 'gestor'
    });
    const id = criado.corpo.usuario.id;

    const dele = amb.sessao(id);
    assert.equal((await dele.get('/api/admin/metricas')).status, 200);

    const editado = await mestre.put(`/api/admin/usuarios/${id}`, { nivel: 'operacao' });
    assert.equal(editado.corpo.usuario.nivel, 'operacao');
    assert.equal(editado.corpo.usuario.nome, 'Efêmero de Teste', 'edição parcial preserva o nome');

    const removido = await mestre.apagar(`/api/admin/usuarios/${id}`);
    assert.equal(removido.status, 200);

    assert.equal((await dele.get('/api/admin/metricas')).status, 401);
  });

  it('as métricas do painel batem com o banco', async () => {
    const r = await mestre.get('/api/admin/metricas');

    assert.equal(r.status, 200);
    assert.equal(
      r.corpo.metricas.campeonatos,
      db.valor('SELECT COUNT(*) FROM campeonatos WHERE arquivado_em IS NULL')
    );
    assert.equal(
      r.corpo.metricas.inscritos,
      db.valor("SELECT COUNT(*) FROM inscricoes WHERE status <> 'cancelada'")
    );
  });

  /* ------------------------------------------------------------------------
     RANKING MANUAL
     ------------------------------------------------------------------------ */

  it('o master corrige uma linha do ranking sem apagar o resto', async () => {
    const antes = await amb.anonimo().get('/api/ranking/futebol');
    const linha = antes.corpo.ranking[0];

    const r = await mestre.put('/api/ranking/futebol', { nome: linha.nome, v: 99 });
    assert.equal(r.status, 200);

    const depois = r.corpo.ranking.find((l) => l.nome === linha.nome);
    assert.equal(depois.v, 99);
    assert.equal(depois.pos, linha.pos, 'edição parcial preserva a posição');
    assert.equal(depois.uf, linha.uf, 'edição parcial preserva a UF');

    assert.equal((await amb.anonimo().get('/api/ranking/xadrez')).status, 404);
  });

  it('linha de ranking sem nome derruba a transação inteira', async () => {
    const antes = await amb.anonimo().get('/api/ranking/shooter');

    const r = await mestre.put('/api/ranking/shooter', { linhas: [{ nome: 'Válido' }, { v: 1 }] });
    assert.equal(r.status, 400);

    const depois = await amb.anonimo().get('/api/ranking/shooter');
    assert.deepEqual(depois.corpo.ranking, antes.corpo.ranking, 'a substituição não podia ficar pela metade');
  });

  /* ------------------------------------------------------------------------
     HISTÓRICO (LIXEIRA)
     ------------------------------------------------------------------------ */

  it('a lixeira lista, restaura e só então exclui em definitivo', async () => {
    const criado = await mestre.post('/api/parceiros', { nome: 'Parceiro Descartável' });
    const id = criado.corpo.parceiro.id;

    const semArquivar = await mestre.apagar('/api/historico', { tabela: 'parceiros', id });
    assert.equal(semArquivar.status, 409, 'excluir sem passar pela lixeira não pode');

    await mestre.apagar(`/api/parceiros/${id}`);

    const lista = await mestre.get('/api/historico?tabela=parceiros');
    assert.ok(lista.corpo.itens.some((i) => i.id === id));
    assert.ok(lista.corpo.itens.every((i) => i.tabela === 'parceiros' && i.nome && i.data));

    const tabelaTorta = await mestre.get('/api/historico?tabela=contas;DROP');
    assert.equal(tabelaTorta.status, 400);

    const emCirculacao = await mestre.post('/api/historico/restaurar', {
      tabela: 'parceiros', id: db.valor('SELECT id FROM parceiros WHERE arquivado_em IS NULL LIMIT 1')
    });
    assert.equal(emCirculacao.status, 409);

    const inexistente = await mestre.post('/api/historico/restaurar', {
      tabela: 'parceiros', id: 'nao-existe'
    });
    assert.equal(inexistente.status, 404);

    const restaurado = await mestre.post('/api/historico/restaurar', { tabela: 'parceiros', id });
    assert.equal(restaurado.status, 200);
    assert.equal(db.valor('SELECT arquivado_em FROM parceiros WHERE id = ?', id), null);

    await mestre.apagar(`/api/parceiros/${id}`);
    const excluido = await mestre.apagar('/api/historico', { tabela: 'parceiros', id });
    assert.equal(excluido.status, 200);
    assert.equal(db.um('SELECT id FROM parceiros WHERE id = ?', id), null);

    assert.ok(db.valor("SELECT COUNT(*) FROM auditoria WHERE acao = 'excluiu em definitivo'") > 0);
  });

  /* ------------------------------------------------------------------------
     E-MAIL
     ------------------------------------------------------------------------ */

  it('em desenvolvimento os envios ficam simulados, e o histórico da semente permanece', async () => {
    const teste = await mestre.post('/api/email/testar', {});
    assert.equal(teste.status, 200);
    /* Sem cliente SMTP, gravar 'entregue' seria mentira no histórico: a tela
       precisa saber que o envio foi apenas registrado. */
    assert.equal(teste.corpo.simulado, true);

    const porStatus = db.todos(
      'SELECT status, COUNT(*) AS quantos FROM emails_enviados GROUP BY status'
    );
    const indice = Object.fromEntries(porStatus.map((l) => [l.status, l.quantos]));

    /* A semente traz três envios antigos marcados como entregues — eles contam
       a história do sistema e continuam lá, sem serem reescritos. */
    assert.equal(indice.entregue, 3);
    assert.ok(indice.simulado > 0);
    assert.equal(indice.fila, undefined, 'em modo dev nada deveria ficar na fila');

    const lista = await mestre.get('/api/email/enviados');
    assert.equal(lista.status, 200);
    assert.ok(lista.corpo.enviados.length > 0);
    assert.equal(lista.corpo.fila, 0);
  });

  it('só o master ajusta o SMTP, e a senha nunca volta na resposta', async () => {
    const leitura = await mestre.get('/api/email/smtp');
    assert.equal(leitura.status, 200);
    assert.ok(leitura.corpo.smtp.email);
    assert.ok(!/"senha"\s*:\s*"/.test(leitura.texto), 'a senha do SMTP não tem coluna e não pode sair');

    const gravado = await mestre.put('/api/email/smtp', { porta: 465, seguranca: 'ssl' });
    assert.equal(gravado.status, 200);
    assert.ok(!/"senha"\s*:\s*"/.test(gravado.texto));
  });

  it('a prévia do e-mail substitui as variáveis e monta o HTML do modelo', async () => {
    const vazia = await mestre.post('/api/email/previa', { assunto: '', corpo: 'texto' });
    assert.equal(vazia.status, 400);

    const r = await mestre.post('/api/email/previa', {
      assunto: 'Olá, {{usuario.nome}}',
      corpo: '<p>Seu time é {{time.nome}}.</p>'
    });

    assert.equal(r.status, 200);
    assert.ok(!r.corpo.assunto.includes('{{'), 'a prévia precisa mostrar o texto final');
    assert.ok(!r.corpo.html.includes('{{'));
    /* O modelo fixo do briefing: logo, assunto, corpo e rodapé. */
    assert.match(r.corpo.html, /Phygital/);
  });

  it('o bootstrap continua íntegro depois de todas as escritas da suíte', async () => {
    const r = await mestre.get('/api/bootstrap');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.dados.bannersSite.length,
      db.valor('SELECT COUNT(*) FROM banners_site'));
    assert.equal(r.corpo.dados.posts.length,
      db.valor('SELECT COUNT(*) FROM posts WHERE arquivado_em IS NULL'));
    assert.equal(r.corpo.dados.adminUsuarios.length,
      db.valor("SELECT COUNT(*) FROM contas WHERE papel = 'admin' AND arquivado_em IS NULL"));
    assert.ok(r.corpo.dados.auditoria.length > 0);
  });
});
