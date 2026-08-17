/* ==========================================================================
   AUTENTICAÇÃO — login, códigos por e-mail e manutenção da conta

   Cada cliente destes testes usa um IP próprio (ver apoio/ambiente.js). Isso
   importa aqui mais que em qualquer outro arquivo: o freio de força bruta e as
   cotas de ritmo do servidor contam por IP, e sem separação o teste do freio
   derrubaria o login de todos os outros.
   ========================================================================== */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const db = amb.db;
const auth = amb.auth;

describe('autenticação', () => {
  /* ------------------------------------------------------------------------
     LOGIN
     ------------------------------------------------------------------------ */

  it('senha errada e e-mail inexistente devolvem exatamente a mesma resposta', async () => {
    const senhaErrada = await amb.cliente().post('/api/auth/login', {
      email: amb.CONTAS.competidor.email, senha: 'EstaSenhaNaoConfere9'
    });
    const contaInexistente = await amb.cliente().post('/api/auth/login', {
      email: 'ninguem.mesmo@exemplo.com', senha: 'EstaSenhaNaoConfere9'
    });

    /* Diferenciar os dois casos transforma a tela de login em consulta de base
       de e-mails: qualquer um descobre quem tem conta. */
    assert.equal(senhaErrada.status, 401);
    assert.equal(contaInexistente.status, 401);
    assert.equal(senhaErrada.corpo.erro, contaInexistente.corpo.erro);
    assert.equal(senhaErrada.corpo.erro, 'E-mail ou senha incorretos.');
    assert.deepEqual(Object.keys(senhaErrada.corpo).sort(), Object.keys(contaInexistente.corpo).sort());
  });

  it('login correto abre sessão com cookie HttpOnly e diz para onde ir', async () => {
    const { cliente, resposta } = await amb.entrar(
      amb.CONTAS.competidor.email, amb.SENHA_COMPETIDOR
    );

    assert.equal(resposta.status, 200);
    assert.equal(resposta.corpo.conta.destino, 'inicio.html');
    assert.equal(resposta.corpo.precisaTrocarSenha, false);

    const posto = resposta.cookies.join('; ');
    assert.match(posto, /phygital_sessao=/);
    assert.match(posto, /HttpOnly/);
    assert.match(posto, /SameSite=Lax/);

    const sessao = await cliente.get('/api/auth/sessao');
    assert.equal(sessao.corpo.conta.email, amb.CONTAS.competidor.email);
  });

  it('o admin master entra e é mandado para o painel de administração', async () => {
    const { resposta } = await amb.entrar(amb.CONTAS.master.email, amb.SENHA_ADMIN);

    assert.equal(resposta.status, 200);
    assert.equal(resposta.corpo.conta.papel, 'admin');
    assert.equal(resposta.corpo.conta.nivel, 'master');
    assert.equal(resposta.corpo.conta.destino, '../admin/index.html');
  });

  it('sem sessão a consulta de sessão responde 200 com conta nula', async () => {
    const r = await amb.anonimo().get('/api/auth/sessao');

    assert.equal(r.status, 200);
    assert.equal(r.corpo.conta, null);
  });

  it('rota protegida sem sessão devolve 401', async () => {
    const cli = amb.anonimo();

    for (const caminho of ['/api/times', '/api/inscricoes', '/api/chamados', '/api/conta/sessoes']) {
      const r = await cli.get(caminho);
      assert.equal(r.status, 401, `${caminho} deveria exigir login`);
    }
  });

  it('logout apaga o cookie e a sessão deixa de valer', async () => {
    const { cliente } = await amb.entrar(amb.CONTAS.competidor.email, amb.SENHA_COMPETIDOR);

    const saida = await cliente.post('/api/auth/logout', {});
    assert.equal(saida.status, 200);
    assert.match(saida.cookies.join('; '), /Max-Age=0/);

    const depois = await cliente.get('/api/auth/sessao');
    assert.equal(depois.corpo.conta, null);
  });

  /* ------------------------------------------------------------------------
     FREIO DE FORÇA BRUTA
     ------------------------------------------------------------------------ */

  it('oito senhas erradas travam a conta, e a senha certa também passa a levar 429', async () => {
    const vitima = amb.novoCompetidor('Alvo do Ataque');
    const atacante = amb.cliente();

    let respostas = [];
    for (let i = 0; i < 8; i += 1) {
      respostas.push(await atacante.post('/api/auth/login', {
        email: vitima.email, senha: `chuteErrado${i}`
      }));
    }
    assert.ok(respostas.every((r) => r.status === 401), 'as 8 primeiras são credencial errada');

    const nona = await atacante.post('/api/auth/login', {
      email: vitima.email, senha: 'maisUmChute999'
    });
    assert.equal(nona.status, 429);
    assert.match(nona.corpo.erro, /Muitas tentativas/);

    /* O freio é por conta também, não só por IP: o atacante que troca de rede
       continua barrado, e é essa a metade que protege de verdade. */
    const outraRede = await amb.cliente().post('/api/auth/login', {
      email: vitima.email, senha: vitima.senha
    });
    assert.equal(outraRede.status, 429);

    /* Limpa o freio para não contaminar os testes seguintes. */
    auth.limparTentativas(vitima.email);
    auth.limparTentativas(atacante.ip);

    const depois = await amb.cliente().post('/api/auth/login', {
      email: vitima.email, senha: vitima.senha
    });
    assert.equal(depois.status, 200);
  });

  it('a recuperação de senha tem cota de ritmo por IP', async () => {
    const cli = amb.cliente();
    let bloqueou = 0;

    for (let i = 0; i < 12; i += 1) {
      const r = await cli.post('/api/auth/recuperar-senha', { email: 'quem.sabe@exemplo.com' });
      if (r.status === 429) { bloqueou = i; break; }
    }

    assert.ok(bloqueou > 0, 'a rota de recuperação deveria estancar o spam');
  });

  /* ------------------------------------------------------------------------
     CADASTRO E CÓDIGO DE VERIFICAÇÃO
     ------------------------------------------------------------------------ */

  it('cadastro recusa senha fraca, aceita senha forte e devolve código', async () => {
    const cli = amb.cliente();
    const email = 'cadastro.teste@exemplo.com';

    const fraca = await cli.post('/api/auth/cadastro', {
      nome: 'Fulano de Teste', email, senha: 'senha123'
    });
    assert.equal(fraca.status, 400);
    assert.ok(Array.isArray(fraca.corpo.erros) && fraca.corpo.erros.length > 0);

    const boa = await cli.post('/api/auth/cadastro', {
      nome: 'Fulano de Teste', email, telefone: '(11) 98888-0000', senha: 'Cordilheira77Sul'
    });
    assert.equal(boa.status, 200);
    assert.equal(boa.corpo.precisaVerificarEmail, true);
    assert.match(String(boa.corpo.codigo), /^\d{6}$/);

    const repetido = await cli.post('/api/auth/cadastro', {
      nome: 'Outro', email: email.toUpperCase(), senha: 'Cordilheira77Sul'
    });
    assert.equal(repetido.status, 409);
  });

  it('o código de verificação é de uso único', async () => {
    const cli = amb.cliente();
    const email = 'uso.unico@exemplo.com';

    const cadastro = await cli.post('/api/auth/cadastro', {
      nome: 'Uso Unico Teste', email, senha: 'Peninsula44Leste'
    });
    const codigo = cadastro.corpo.codigo;

    const primeira = await cli.post('/api/auth/verificar-email', { email, codigo });
    assert.equal(primeira.status, 200);
    assert.equal(primeira.corpo.conta.emailVerificado, true);

    const segunda = await cli.post('/api/auth/verificar-email', { email, codigo });
    assert.equal(segunda.status, 400);
    assert.match(segunda.corpo.erro, /Nenhum código pendente/);
  });

  it('o código expira e o expirado não confirma nada', async () => {
    const cli = amb.cliente();
    const email = 'expirado@exemplo.com';

    const cadastro = await cli.post('/api/auth/cadastro', {
      nome: 'Expirado Teste', email, senha: 'Arquipelago21Norte'
    });
    const conta = db.um('SELECT id FROM contas WHERE lower(email) = ?', email);

    /* Empurra a expiração para trás em vez de esperar 15 minutos. */
    db.executar(
      "UPDATE codigos SET expira_em = ? WHERE conta_id = ? AND finalidade = 'verificar-email'",
      new Date(Date.now() - 60000).toISOString(), conta.id
    );

    const r = await cli.post('/api/auth/verificar-email', { email, codigo: cadastro.corpo.codigo });
    assert.equal(r.status, 400);
    assert.match(r.corpo.erro, /expirou/i);
    assert.equal(db.valor('SELECT email_verificado FROM contas WHERE id = ?', conta.id), 0);
  });

  it('cinco códigos errados esgotam as tentativas — o certo já não vale', async () => {
    const cli = amb.cliente();
    const email = 'tentativas@exemplo.com';

    const cadastro = await cli.post('/api/auth/cadastro', {
      nome: 'Tentativas Teste', email, senha: 'Meridiano58Oeste'
    });
    const certo = cadastro.corpo.codigo;
    /* Um errado que nunca colide com o certo. */
    const errado = certo === '000000' ? '111111' : '000000';

    const mensagens = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await cli.post('/api/auth/verificar-email', { email, codigo: errado });
      assert.equal(r.status, 400);
      mensagens.push(r.corpo.erro);
    }

    /* A contagem regressiva é visível para quem digitou errado de boa-fé. */
    assert.match(mensagens[0], /4 tentativa\(s\) restante\(s\)/);

    const comOCerto = await cli.post('/api/auth/verificar-email', { email, codigo: certo });
    assert.equal(comOCerto.status, 400);
    assert.match(comOCerto.corpo.erro, /Muitas tentativas/);
    assert.equal(
      db.valor('SELECT email_verificado FROM contas WHERE lower(email) = ?', email), 0
    );
  });

  it('pedir um código novo invalida o anterior', async () => {
    const cli = amb.cliente();
    const email = 'reenvio@exemplo.com';

    const cadastro = await cli.post('/api/auth/cadastro', {
      nome: 'Reenvio Teste', email, senha: 'Estuario63Central'
    });
    const primeiro = cadastro.corpo.codigo;

    const reenvio = await cli.post('/api/auth/reenviar-codigo', {
      email, finalidade: 'verificar-email'
    });
    const segundo = reenvio.corpo.codigo;
    assert.notEqual(primeiro, segundo);

    const comOVelho = await cli.post('/api/auth/verificar-email', { email, codigo: primeiro });
    assert.equal(comOVelho.status, 400);

    const comONovo = await cli.post('/api/auth/verificar-email', { email, codigo: segundo });
    assert.equal(comONovo.status, 200);
  });

  /* ------------------------------------------------------------------------
     RECUPERAÇÃO DE SENHA
     ------------------------------------------------------------------------ */

  it('a recuperação responde a mesma frase exista ou não a conta', async () => {
    const alvo = amb.novoCompetidor('Esquecido');

    const existe = await amb.cliente().post('/api/auth/recuperar-senha', { email: alvo.email });
    const naoExiste = await amb.cliente().post('/api/auth/recuperar-senha', {
      email: 'jamais.cadastrado@exemplo.com'
    });

    assert.equal(existe.status, 200);
    assert.equal(naoExiste.status, 200);
    assert.equal(existe.corpo.mensagem, naoExiste.corpo.mensagem);
    /* Só a conta que existe gera código — mas isso não aparece na mensagem. */
    assert.ok(existe.corpo.codigo);
    assert.equal(naoExiste.corpo.codigo, undefined);
  });

  it('redefinir por código confirma o e-mail e derruba as sessões abertas', async () => {
    const alvo = amb.novoCompetidor('Redefinicao');
    db.executar('UPDATE contas SET email_verificado = 0 WHERE id = ?', alvo.id);

    const antiga = amb.sessao(alvo.id);
    assert.equal((await antiga.get('/api/auth/sessao')).corpo.conta.id, alvo.id);

    const cli = amb.cliente();
    const pedido = await cli.post('/api/auth/recuperar-senha', { email: alvo.email });
    const codigo = pedido.corpo.codigo;

    /* Senha ruim é recusada ANTES de o código ser consumido — senão o usuário
       precisaria de outro código só porque digitou uma senha curta. */
    const curta = await cli.post('/api/auth/redefinir-senha', {
      email: alvo.email, codigo, senha: 'curta1'
    });
    assert.equal(curta.status, 400);
    assert.ok(Array.isArray(curta.corpo.erros));

    const nova = 'Cachoeira92Grande';
    const ok = await cli.post('/api/auth/redefinir-senha', { email: alvo.email, codigo, senha: nova });
    assert.equal(ok.status, 200);

    /* A sessão anterior foi invalidada junto com a senha. */
    assert.equal((await antiga.get('/api/auth/sessao')).corpo.conta, null);

    /* Receber o código na caixa prova a posse do endereço: o e-mail fica
       confirmado, e o login seguinte não pede verificação nenhuma. */
    const entrada = await amb.cliente().post('/api/auth/login', { email: alvo.email, senha: nova });
    assert.equal(entrada.status, 200);
    assert.equal(entrada.corpo.precisaVerificarEmail, false);
    assert.equal(db.valor('SELECT email_verificado FROM contas WHERE id = ?', alvo.id), 1);
  });

  /* ------------------------------------------------------------------------
     MINHA CONTA
     ------------------------------------------------------------------------ */

  it('a troca de senha derruba as outras sessões e mantém a de quem trocou', async () => {
    const dono = amb.novoCompetidor('Multi Sessao');

    /* A conta já nasce com uma sessão (a de dono.cliente); estas são o mesmo
       usuário em outros dois aparelhos. */
    const notebook = dono.cliente;
    const celular = amb.sessao(dono.id);
    const tablet = amb.sessao(dono.id);

    const lista = await notebook.get('/api/conta/sessoes');
    assert.equal(lista.corpo.sessoes.length, 3);
    assert.equal(lista.corpo.sessoes.filter((s) => s.atual).length, 1);
    /* O token_hash inteiro nunca sai do servidor. */
    assert.ok(!lista.texto.includes('token_hash'));
    assert.match(lista.corpo.sessoes[0].id, /^[0-9a-f]{16}$/);

    const errada = await notebook.post('/api/conta/senha', {
      senhaAtual: 'naoEssa123456', novaSenha: 'Promontorio31Sul'
    });
    assert.equal(errada.status, 401);

    const troca = await notebook.post('/api/conta/senha', {
      senhaAtual: dono.senha, novaSenha: 'Promontorio31Sul'
    });
    assert.equal(troca.status, 200);

    /* Quem trocou continua dentro: o Set-Cookie da resposta reabriu a sessão. */
    assert.equal((await notebook.get('/api/auth/sessao')).corpo.conta.id, dono.id);
    /* Os outros aparelhos caem — inclusive o de quem tenha roubado a senha. */
    assert.equal((await celular.get('/api/auth/sessao')).corpo.conta, null);
    assert.equal((await tablet.get('/api/auth/sessao')).corpo.conta, null);

    const sobrou = await notebook.get('/api/conta/sessoes');
    assert.equal(sobrou.corpo.sessoes.length, 1);
    assert.equal(sobrou.corpo.sessoes[0].atual, true);

    /* E a senha antiga não abre mais nada. */
    const velha = await amb.cliente().post('/api/auth/login', {
      email: dono.email, senha: dono.senha
    });
    assert.equal(velha.status, 401);
  });

  it('alterar dados cadastrais exige confirmação por código', async () => {
    const dono = amb.novoCompetidor('Dados Cadastrais');

    const pedido = await dono.cliente.post('/api/conta/dados', {
      nome: 'Nome Corrigido', telefone: '(11) 97777-1111'
    });
    assert.equal(pedido.status, 200);
    assert.equal(pedido.corpo.precisaCodigo, true);

    /* Nada mudou ainda: o pendente vive no código, não na conta. */
    assert.equal(db.valor('SELECT nome FROM contas WHERE id = ?', dono.id), dono.nome);

    const errado = await dono.cliente.post('/api/conta/dados', { codigo: '000000' });
    assert.ok(errado.status === 400);

    const confirmado = await dono.cliente.post('/api/conta/dados', { codigo: pedido.corpo.codigo });
    assert.equal(confirmado.status, 200);
    assert.equal(confirmado.corpo.conta.nome, 'Nome Corrigido');
    assert.equal(db.valor('SELECT telefone FROM contas WHERE id = ?', dono.id), '(11) 97777-1111');
  });

  it('trocar o e-mail manda o código para o endereço ANTIGO', async () => {
    const dono = amb.novoCompetidor('Troca de Email');
    const novoEmail = `novo.${dono.id}@exemplo.com`;

    const pedido = await dono.cliente.post('/api/conta/email', { novoEmail });
    assert.equal(pedido.status, 200);
    /* Regra do briefing: quem tomou a conta não muda o endereço sem ter acesso
       à caixa original. */
    assert.equal(pedido.corpo.destino, dono.email);

    const gravado = db.um(
      `SELECT destino FROM codigos
        WHERE conta_id = ? AND finalidade = 'trocar-email' ORDER BY criado_em DESC LIMIT 1`,
      dono.id
    );
    assert.equal(gravado.destino, dono.email);

    const email = db.um(
      "SELECT * FROM emails_enviados WHERE destino = ? AND modelo_id = 'codigo-verificacao' ORDER BY data DESC LIMIT 1",
      dono.email
    );
    assert.ok(email, 'o código tinha que ter saído para o e-mail antigo');

    const confirmado = await dono.cliente.post('/api/conta/email/confirmar', {
      codigo: pedido.corpo.codigo
    });
    assert.equal(confirmado.status, 200);
    assert.equal(confirmado.corpo.conta.email, novoEmail);
    /* O endereço novo ainda não provou existir. */
    assert.equal(confirmado.corpo.conta.emailVerificado, false);
  });

  it('o admin de senha provisória é obrigado a definir a definitiva e confirmar o e-mail', async () => {
    const provisoria = 'Provisoria2026x';
    const credencial = auth.criarSenha(provisoria);
    const email = 'primeiro.acesso@exemplo.com';

    db.executar(
      `INSERT INTO contas (id, nome, email, senha_hash, senha_salt, papel, nivel,
                           email_verificado, senha_provisoria, criado_em)
       VALUES ('teste-primeiro-acesso', 'Gestor Recém-Chegado', ?, ?, ?, 'admin', 'gestor', 1, 1, ?)`,
      email, credencial.senha_hash, credencial.senha_salt, db.agora()
    );

    const cli = amb.cliente();

    const entrada = await cli.post('/api/auth/login', { email, senha: provisoria });
    assert.equal(entrada.status, 200);
    assert.equal(entrada.corpo.precisaTrocarSenha, true);

    const errada = await cli.post('/api/auth/primeiro-acesso', {
      email, senhaAtual: 'naoEhEssa1234', novaSenha: 'Farolete88Norte'
    });
    assert.equal(errada.status, 401);

    const repetida = await cli.post('/api/auth/primeiro-acesso', {
      email, senhaAtual: provisoria, novaSenha: provisoria
    });
    assert.equal(repetida.status, 400);

    const trocada = await cli.post('/api/auth/primeiro-acesso', {
      email, senhaAtual: provisoria, novaSenha: 'Farolete88Norte'
    });
    assert.equal(trocada.status, 200);
    assert.equal(trocada.corpo.precisaVerificarEmail, true);

    /* Segunda vez não vale: a conta já tem senha definitiva. */
    const denovo = await cli.post('/api/auth/primeiro-acesso', {
      email, senhaAtual: 'Farolete88Norte', novaSenha: 'Outra99Coisa'
    });
    assert.equal(denovo.status, 409);

    const confirmado = await cli.post('/api/auth/verificar-email', {
      email, codigo: trocada.corpo.codigo
    });
    assert.equal(confirmado.status, 200);

    const final = await amb.cliente().post('/api/auth/login', { email, senha: 'Farolete88Norte' });
    assert.equal(final.corpo.precisaTrocarSenha, false);
    assert.equal(final.corpo.precisaVerificarEmail, false);
    assert.equal(final.corpo.conta.destino, '../admin/index.html');
  });

  it('a auditoria registra quem entrou, com nome e não como "sistema"', () => {
    const linha = db.um(
      "SELECT * FROM auditoria WHERE area = 'conta' AND acao = 'entrou no painel' ORDER BY id DESC LIMIT 1"
    );

    assert.ok(linha, 'nenhum login foi auditado');
    assert.notEqual(linha.autor, 'sistema');
    assert.ok(linha.conta_id);
    assert.ok(linha.ip);
  });
});
