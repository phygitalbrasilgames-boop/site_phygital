/* ==========================================================================
   PHYGITAL BRASIL — ROTAS DE CONTA E SESSÃO

   Login, cadastro, códigos por e-mail e manutenção da própria conta. Toda a
   criptografia e o freio de força bruta ficam em ../auth.js; aqui só há fluxo,
   validação de entrada e as respostas.

   Três decisões atravessam o arquivo:

   · Nada aqui revela quem tem conta. Recuperação de senha responde sempre a
     mesma frase, e "conta inexistente" produz a mesma mensagem que "código
     errado". Uma tela pública que distingue os dois casos vira consulta de
     base de e-mails.
   · O formato da senha nova é conferido ANTES do código de verificação. Como
     conferirCodigo() marca o código como usado, a ordem inversa obrigaria o
     usuário a pedir outro código só porque digitou uma senha curta.
   · Alteração de dados sensíveis é em dois passos: a primeira chamada guarda o
     que vai mudar em codigos.carga e dispara o código; a segunda confirma. O
     valor pendente nunca fica solto numa tabela de conta.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const auth = require('../auth');
const mapa = require('../mapa');
const regras = require('../regras');
const { erro400, erro401, erro409, erro429 } = require('../http');

/* index.js também trata a ausência de PHYGITAL_MODO como 'dev'. As duas
   metades do servidor precisam concordar sobre o que é desenvolvimento. */
const MODO = process.env.PHYGITAL_MODO || 'dev';
const DEV = MODO === 'dev';

/* Finalidades aceitas pela coluna codigos.finalidade. As duas primeiras valem
   para quem ainda não entrou; as outras só fazem sentido com sessão aberta. */
const FINALIDADES_ANONIMAS = ['verificar-email', 'recuperar-senha'];
const FINALIDADES_LOGADAS = ['trocar-email', 'alterar-conta'];

/* Mesma frase para e-mail existente e inexistente. */
const RESPOSTA_NEUTRA = 'Se houver uma conta com este e-mail, enviamos as instruções para ela.';

/* Quantos caracteres do hash identificam uma sessão na listagem. 16 hexas já
   tornam a colisão irrelevante e o token_hash inteiro não sai do servidor. */
const IDENT_SESSAO = 16;

/* --------------------------------------------------------------------------
   ENTRADA
   -------------------------------------------------------------------------- */

const texto = (v, max) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);

const normalizarEmail = (v) => texto(v, 160).toLowerCase();

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** A conta ativa daquele e-mail, ou null. Arquivada não entra em nenhum fluxo. */
const contaPorEmail = (email) => db.um(
  'SELECT * FROM contas WHERE lower(email) = ? AND arquivado_em IS NULL', email
);

const contaPorId = (id) => db.um('SELECT * FROM contas WHERE id = ?', id);

/**
 * Cota por IP reaproveitando o contador do login (tabela tentativas_login). O
 * prefixo separa a cota de cada rota da cota de credenciais. Sem isso,
 * /recuperar-senha e /reenviar-codigo viram ferramenta de spam: quem souber um
 * e-mail alheio dispara mensagem à vontade.
 *
 * Cada chamada gasta uma unidade e nada devolve a cota — é limite de ritmo, não
 * contador de falha, então acertar o código não reabre a torneira.
 */
function freio(ctx, rotulo, max) {
  /* Cada rótulo tem cota própria. Compartilhar um rótulo entre fluxos diferentes
     soma o consumo deles: confirmar e-mail, atualizar cadastro e trocar endereço
     esgotariam juntos a cota, e aí o usuário ficaria sem conseguir redefinir a
     senha por 15 minutos — bloqueio de uso legítimo, não de ataque.

     Quem tem sessão é contado pela conta, não pelo IP. Atrás de NAT (empresa,
     Codespaces) um IP é muitas pessoas, e uma esgotaria a cota das outras. */
  const quem = ctx.conta ? `c${ctx.conta.id}` : `ip${ctx.ip}`;
  const chave = `${rotulo}:${quem}`;
  if (auth.bloqueado(chave, max)) throw erro429();
  auth.registrarTentativa(chave, false);
}

/**
 * Faz a auditoria registrar quem agiu em rotas sem sessão (login, confirmação
 * de e-mail, redefinição de senha). regras.registrar lê ctx._conta; sem isto o
 * registro sairia como "sistema" justamente nas ações mais sensíveis.
 */
const assinar = (ctx, conta) => { ctx._conta = conta; };

/* O banco guarda o SHA-256 do token (ver ../auth.js); o cálculo é repetido aqui
   só para marcar qual linha da listagem é a sessão desta requisição. */
const hashDoToken = (token) => (
  token ? crypto.createHash('sha256').update(String(token)).digest('hex') : null
);

/**
 * O código em claro SÓ volta no corpo da resposta em desenvolvimento, para os
 * testes automatizados não precisarem abrir a caixa de e-mail. Em produção ele
 * existe apenas dentro da mensagem enviada — não remova esta guarda.
 */
const devCodigo = (gerado) => (DEV && gerado ? { codigo: gerado.codigo, expiraEm: gerado.expira } : {});

/* --------------------------------------------------------------------------
   E-MAIL

   Caminho único de envio (o briefing proíbe um segundo). Em desenvolvimento
   nada sai de verdade: a mensagem é gravada em emails_enviados com
   status='simulado' e pode ser inspecionada nos testes e na tela de histórico.
   Em produção fica em 'fila' — o remetente SMTP ainda não existe, e gravar como
   'entregue' o que ninguém entregou seria mentira no histórico.
   -------------------------------------------------------------------------- */

/* Rede de segurança para o caso de a base não ter os modelos (semente ainda não
   rodada, ou modelo apagado pela tela de administração). Vale só para mensagem
   essencial: um código de verificação não pode deixar de sair. */
const RESERVA = {
  'codigo-verificacao': {
    assunto: 'Seu código de verificação é {{codigo}}',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Seu código de verificação é <b>{{codigo}}</b>. Ele vale por {{minutos}} minutos.</p>'
  },
  'senha-recuperacao': {
    assunto: 'Recuperação de senha — Phygital Brasil',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Use o código <b>{{codigo}}</b> para criar uma nova senha. O código vale por {{minutos}} minutos.</p>'
  },
  'senha-alterada': {
    assunto: 'Sua senha foi alterada',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>A senha da sua conta foi alterada em {{data}}. Se não foi você, fale com a organização imediatamente.</p>'
  }
};

const escaparHtml = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Troca {{a.b}} pelo valor correspondente do contexto.
 *
 * O valor é escapado no corpo porque o corpo é HTML e a tela de histórico do
 * administrador imprime a prévia com innerHTML: um nome de usuário contendo
 * <script> viraria XSS armazenado. Variável desconhecida vira string vazia para
 * não vazar a chave crua para o destinatário.
 */
function renderizar(modelo, contexto, { escapar = true } = {}) {
  return String(modelo || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, chave) => {
    const valor = chave.split('.').reduce(
      (o, k) => (o === null || o === undefined ? undefined : o[k]), contexto
    );
    if (valor === undefined || valor === null) return '';
    return escapar ? escaparHtml(valor) : String(valor);
  });
}

/** Variáveis que os modelos de conta usam (ver mapa.VARIAVEIS_EMAIL). */
function contextoEmail(conta, extra = {}) {
  return {
    usuario: {
      nome: conta.nome,
      email: conta.email,
      telefone: conta.telefone || ''
    },
    data: mapa.dataHora(db.agora()),
    ...extra
  };
}

/**
 * Monta a mensagem a partir do modelo e registra o envio.
 * `essencial` ignora o interruptor `ativo` do modelo: avisos podem ser
 * desligados na tela de administração, códigos de segurança não.
 */
function enviarModelo(modeloId, { destino, contexto, essencial = false }) {
  const modelo = db.um('SELECT * FROM modelos_email WHERE id = ?', modeloId);
  const desligado = !modelo || !db.bool(modelo.ativo);

  if (desligado && !essencial) return null;

  const base = modelo && !desligado ? modelo : (RESERVA[modeloId] || modelo);
  if (!base) return null;

  const assunto = renderizar(base.assunto, contexto, { escapar: false });
  const corpo = renderizar(base.corpo, contexto);
  const id = crypto.randomUUID();

  db.executar(
    `INSERT INTO emails_enviados (id, modelo_id, assunto, destino, para, corpo, qtd, status, erro, data)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)`,
    id, modelo ? modelo.id : null, assunto, destino,
    modelo ? modelo.para : 'competidor', corpo,
    DEV ? 'simulado' : 'fila', db.agora()
  );

  return { id, assunto, destino };
}

/** Atalho do par mais usado: gera o código e manda o e-mail que o carrega. */
function enviarCodigo(conta, destino, gerado, modeloId = 'codigo-verificacao') {
  return enviarModelo(modeloId, {
    destino,
    essencial: true,
    contexto: contextoEmail(conta, { codigo: gerado.codigo, minutos: gerado.minutos })
  });
}

const avisarSenhaAlterada = (conta) => enviarModelo('senha-alterada', {
  destino: conta.email,
  essencial: true,
  contexto: contextoEmail(conta)
});

/* --------------------------------------------------------------------------
   SENHA
   -------------------------------------------------------------------------- */

/** Aplica a política de ../auth.js e devolve o par hash/sal já pronto. */
function prepararSenha(nova, conta) {
  const erros = auth.avaliarSenha(nova, { email: conta.email, nome: conta.nome });
  if (erros.length) throw erro400('A senha escolhida não atende aos requisitos.', { erros });
  return auth.criarSenha(nova);
}

/**
 * Grava a senha nova e derruba a flag de provisória. Quem chama decide o que
 * fazer com as sessões — trocar a senha sempre invalida todas, mas a rota
 * logada precisa reabrir a sua em seguida.
 */
function gravarSenha(contaId, credencial) {
  db.executar(
    `UPDATE contas
        SET senha_hash = ?, senha_salt = ?, senha_provisoria = 0, atualizado_em = ?
      WHERE id = ?`,
    credencial.senha_hash, credencial.senha_salt, db.agora(), contaId
  );
}

/* ==========================================================================
   ROTAS
   ========================================================================== */

function registrar(rotas) {
  /* ------------------------------------------------------------------------
     SESSÃO
     ------------------------------------------------------------------------ */

  rotas.post('/api/auth/login', async (ctx) => {
    const corpo = await ctx.corpo();
    const r = auth.autenticar(corpo.email, corpo.senha, { ip: ctx.ip, agente: ctx.agente });

    if (!r.ok) {
      /* 'bloqueado' é o freio de força bruta, não credencial errada: 429 diz ao
         front-end para pedir paciência em vez de pedir a senha de novo. */
      if (r.codigo === 'bloqueado') throw erro429(r.erro);
      throw erro401(r.erro);
    }

    assinar(ctx, contaPorId(r.conta.id));
    regras.registrar(
      ctx, 'conta', r.conta.email, 'entrou no painel',
      r.conta.nivel ? `${r.conta.papel} · ${r.conta.nivel}` : r.conta.papel
    );

    ctx.ok({
      ok: true,
      conta: r.conta,
      precisaTrocarSenha: r.precisaTrocarSenha,
      precisaVerificarEmail: r.precisaVerificarEmail
    }, { 'Set-Cookie': auth.cookieSessao(r.token, { seguro: ctx.seguro, expira: r.expira }) });
  });

  rotas.post('/api/auth/logout', async (ctx) => {
    /* Resolve a conta antes de apagar a sessão, senão não há o que auditar. */
    const conta = ctx.conta;
    if (conta) regras.registrar(ctx, 'conta', conta.email, 'saiu do painel', null);

    auth.encerrarSessao(ctx.token);
    ctx.ok({ ok: true }, { 'Set-Cookie': auth.cookieLimpo({ seguro: ctx.seguro }) });
  });

  /* Consulta barata que o front-end usa para saber se ainda está logado. Sem
     sessão não é erro: responde 200 com conta nula. */
  rotas.get('/api/auth/sessao', async (ctx) => {
    const conta = ctx.conta;
    ctx.ok({
      ok: true,
      conta: auth.contaPublica(conta),
      precisaTrocarSenha: conta ? db.bool(conta.senha_provisoria) : false,
      precisaVerificarEmail: conta ? !db.bool(conta.email_verificado) : false
    });
  });

  /* ------------------------------------------------------------------------
     CADASTRO E VERIFICAÇÃO
     ------------------------------------------------------------------------ */

  rotas.post('/api/auth/cadastro', async (ctx) => {
    const corpo = await ctx.corpo();
    freio(ctx, 'cadastro');

    const nome = texto(corpo.nome, 120);
    const email = normalizarEmail(corpo.email);
    const telefone = texto(corpo.telefone, 40);

    if (nome.length < 3) throw erro400('Informe o seu nome completo.');
    if (!emailValido(email)) throw erro400('Informe um e-mail válido.');

    const credencial = prepararSenha(corpo.senha, { email, nome });

    /* Conta arquivada entra na conta: o índice único de e-mail não distingue, e
       deixar passar aqui só trocaria o 409 por um erro cru do banco. */
    if (db.valor('SELECT COUNT(*) FROM contas WHERE lower(email) = ?', email)) {
      throw erro409('Já existe uma conta com este e-mail.');
    }

    const id = crypto.randomUUID();

    const gerado = db.transacao(() => {
      db.executar(
        `INSERT INTO contas (id, nome, email, telefone, senha_hash, senha_salt,
                             papel, nivel, email_verificado, senha_provisoria, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, 'competidor', NULL, 0, 0, ?)`,
        id, nome, email, telefone || null,
        credencial.senha_hash, credencial.senha_salt, db.agora()
      );

      const conta = { id, nome, email, telefone };
      const codigo = auth.gerarCodigo(id, 'verificar-email', email);

      enviarModelo('conta-criada', { destino: email, contexto: contextoEmail(conta) });
      enviarCodigo(conta, email, codigo);

      regras.registrar(ctx, 'conta', email, 'criou conta de competidor', nome);
      return codigo;
    });

    ctx.ok({
      ok: true,
      conta: auth.contaPublica(contaPorId(id)),
      precisaVerificarEmail: true,
      mensagem: 'Conta criada. Enviamos um código de verificação para o seu e-mail.',
      ...devCodigo(gerado)
    });
  });

  rotas.post('/api/auth/verificar-email', async (ctx) => {
    const corpo = await ctx.corpo();
    freio(ctx, 'verificar-email');

    const conta = contaPorEmail(normalizarEmail(corpo.email));
    /* Conta inexistente responde igual a "não há código": a tela de verificação
       não pode servir para descobrir quais e-mails têm cadastro. */
    if (!conta) throw erro400('Nenhum código pendente. Peça um novo.');

    const r = auth.conferirCodigo(conta.id, 'verificar-email', corpo.codigo);
    if (!r.ok) throw erro400(r.erro);

    db.executar(
      'UPDATE contas SET email_verificado = 1, atualizado_em = ? WHERE id = ?',
      db.agora(), conta.id
    );

    assinar(ctx, conta);
    regras.registrar(ctx, 'conta', conta.email, 'confirmou o e-mail', null);

    ctx.ok({ ok: true, conta: auth.contaPublica(contaPorId(conta.id)) });
  });

  rotas.post('/api/auth/reenviar-codigo', async (ctx) => {
    const corpo = await ctx.corpo();
    freio(ctx, 'reenviar-codigo');

    const finalidade = texto(corpo.finalidade, 40) || 'verificar-email';

    if (FINALIDADES_LOGADAS.includes(finalidade)) {
      const conta = ctx.exigirLogin();

      /* Reemitir 'trocar-email' ou 'alterar-conta' sem saber o que está sendo
         alterado não faz sentido: a carga do código anterior é justamente esse
         dado pendente, e ela é reaproveitada. */
      const anterior = db.um(
        `SELECT * FROM codigos
          WHERE conta_id = ? AND finalidade = ? AND usado_em IS NULL
          ORDER BY criado_em DESC LIMIT 1`,
        conta.id, finalidade
      );
      if (!anterior) throw erro409('Não há alteração pendente para confirmar.');

      const gerado = auth.gerarCodigo(conta.id, finalidade, anterior.destino, db.json(anterior.carga));
      enviarCodigo(conta, anterior.destino, gerado);

      ctx.ok({
        ok: true,
        destino: anterior.destino,
        mensagem: 'Enviamos um novo código.',
        ...devCodigo(gerado)
      });
      return;
    }

    if (!FINALIDADES_ANONIMAS.includes(finalidade)) {
      throw erro400('Finalidade de código desconhecida.');
    }

    const email = normalizarEmail(corpo.email);
    const conta = emailValido(email) ? contaPorEmail(email) : null;
    let gerado = null;

    /* E-mail já confirmado não recebe outro código de confirmação, mas a
       resposta é a mesma de sempre. */
    const jaConfirmado = conta && finalidade === 'verificar-email' && db.bool(conta.email_verificado);

    if (conta && !jaConfirmado) {
      gerado = auth.gerarCodigo(conta.id, finalidade, conta.email);
      enviarCodigo(
        conta, conta.email, gerado,
        finalidade === 'recuperar-senha' ? 'senha-recuperacao' : 'codigo-verificacao'
      );
    }

    ctx.ok({ ok: true, mensagem: RESPOSTA_NEUTRA, ...devCodigo(gerado) });
  });

  /* ------------------------------------------------------------------------
     RECUPERAÇÃO DE SENHA
     ------------------------------------------------------------------------ */

  rotas.post('/api/auth/recuperar-senha', async (ctx) => {
    const corpo = await ctx.corpo();
    freio(ctx, 'recuperar');

    const email = normalizarEmail(corpo.email);
    const conta = emailValido(email) ? contaPorEmail(email) : null;
    let gerado = null;

    if (conta) {
      gerado = auth.gerarCodigo(conta.id, 'recuperar-senha', conta.email);
      enviarCodigo(conta, conta.email, gerado, 'senha-recuperacao');

      assinar(ctx, conta);
      regras.registrar(ctx, 'conta', conta.email, 'pediu recuperação de senha', null);
    }

    /* Sempre 200 e sempre a mesma frase, exista a conta ou não. */
    ctx.ok({ ok: true, mensagem: RESPOSTA_NEUTRA, ...devCodigo(gerado) });
  });

  rotas.post('/api/auth/redefinir-senha', async (ctx) => {
    const corpo = await ctx.corpo();
    freio(ctx, 'redefinir-senha');

    const conta = contaPorEmail(normalizarEmail(corpo.email));
    if (!conta) throw erro400('Nenhum código pendente. Peça um novo.');

    const credencial = prepararSenha(corpo.senha, conta);

    const r = auth.conferirCodigo(conta.id, 'recuperar-senha', corpo.codigo);
    if (!r.ok) throw erro400(r.erro);

    db.transacao(() => {
      gravarSenha(conta.id, credencial);
      /* Receber o código prova o domínio sobre o endereço; uma conta que ainda
         não tinha confirmado o e-mail fica confirmada aqui. */
      db.executar('UPDATE contas SET email_verificado = 1 WHERE id = ?', conta.id);
      /* Senha trocada invalida tudo que estava aberto — inclusive a sessão de
         quem tenha roubado a anterior. */
      auth.encerrarTodasAsSessoes(conta.id);
      avisarSenhaAlterada(conta);

      assinar(ctx, conta);
      regras.registrar(ctx, 'conta', conta.email, 'redefiniu a senha por código', null);
    });

    ctx.ok({ ok: true, mensagem: 'Senha redefinida. Faça login com a nova senha.' });
  });

  /* ------------------------------------------------------------------------
     PRIMEIRO ACESSO DO ADMINISTRADOR

     Briefing: quem recebe senha provisória é obrigado a definir a definitiva e
     a confirmar o e-mail antes de usar o painel.
     ------------------------------------------------------------------------ */

  rotas.post('/api/auth/primeiro-acesso', async (ctx) => {
    const corpo = await ctx.corpo();
    const email = normalizarEmail(corpo.email);

    /* A senha provisória é credencial: usa o mesmo freio e as mesmas chaves do
       login, para não sobrar uma porta com cota própria para tentar senha. */
    if (auth.bloqueado(ctx.ip) || auth.bloqueado(email)) {
      throw erro429('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    }

    const conta = contaPorEmail(email);
    const confere = conta && auth.senhaConfere(corpo.senhaAtual, conta.senha_hash, conta.senha_salt);

    if (!confere) {
      auth.registrarTentativa(ctx.ip, false);
      auth.registrarTentativa(email, false);
      throw erro401('E-mail ou senha incorretos.');
    }

    if (!db.bool(conta.senha_provisoria)) {
      throw erro409('Esta conta já tem senha definitiva. Entre normalmente ou use "Esqueci minha senha".');
    }

    const credencial = prepararSenha(corpo.novaSenha, conta);
    if (auth.senhaConfere(corpo.novaSenha, conta.senha_hash, conta.senha_salt)) {
      throw erro400('A nova senha precisa ser diferente da provisória.');
    }

    auth.limparTentativas(email);

    const gerado = db.transacao(() => {
      gravarSenha(conta.id, credencial);
      /* O e-mail volta a "não confirmado" de propósito: o briefing exige o
         código depois da troca, e é ele que prova que o endereço do novo
         administrador realmente existe. */
      db.executar('UPDATE contas SET email_verificado = 0 WHERE id = ?', conta.id);
      auth.encerrarTodasAsSessoes(conta.id);

      const codigo = auth.gerarCodigo(conta.id, 'verificar-email', conta.email);
      enviarCodigo(conta, conta.email, codigo);
      avisarSenhaAlterada(conta);

      assinar(ctx, conta);
      regras.registrar(ctx, 'conta', conta.email, 'definiu a senha no primeiro acesso', conta.nivel);
      return codigo;
    });

    ctx.ok({
      ok: true,
      precisaVerificarEmail: true,
      mensagem: 'Senha definida. Confirme o código enviado para o seu e-mail em /api/auth/verificar-email.',
      ...devCodigo(gerado)
    });
  });

  /* ------------------------------------------------------------------------
     MINHA CONTA
     ------------------------------------------------------------------------ */

  rotas.post('/api/conta/senha', async (ctx) => {
    const conta = ctx.exigirLogin();
    const corpo = await ctx.corpo();
    freio(ctx, 'senha');

    if (!auth.senhaConfere(corpo.senhaAtual, conta.senha_hash, conta.senha_salt)) {
      throw erro401('A senha atual não confere.');
    }

    const credencial = prepararSenha(corpo.novaSenha, conta);
    if (auth.senhaConfere(corpo.novaSenha, conta.senha_hash, conta.senha_salt)) {
      throw erro400('A nova senha precisa ser diferente da atual.');
    }

    /* Derruba tudo e reabre só esta: quem já estava logado em outro dispositivo
       precisa entrar de novo com a senha nova, mas quem acabou de trocar não é
       expulso da própria tela. */
    const sessao = db.transacao(() => {
      gravarSenha(conta.id, credencial);
      auth.encerrarTodasAsSessoes(conta.id);
      avisarSenhaAlterada(conta);
      regras.registrar(ctx, 'conta', conta.email, 'alterou a senha', null);
      return auth.abrirSessao(conta.id, { ip: ctx.ip, agente: ctx.agente });
    });

    ctx.ok({
      ok: true,
      mensagem: 'Senha alterada. As outras sessões foram encerradas.'
    }, { 'Set-Cookie': auth.cookieSessao(sessao.token, { seguro: ctx.seguro, expira: sessao.expira }) });
  });

  /**
   * Dois passos. Sem `codigo` no corpo, guarda nome e telefone na carga e manda
   * o código; com `codigo`, aplica exatamente o que foi guardado — o valor
   * confirmado é o que o usuário viu quando pediu o código, não o que veio na
   * segunda requisição.
   */
  rotas.post('/api/conta/dados', async (ctx) => {
    const conta = ctx.exigirLogin();
    const corpo = await ctx.corpo();

    if (!corpo.codigo) {
      const nome = texto(corpo.nome, 120) || conta.nome;
      const telefone = corpo.telefone === undefined ? (conta.telefone || '') : texto(corpo.telefone, 40);
      if (nome.length < 3) throw erro400('Informe o seu nome completo.');

      freio(ctx, 'conta-dados');
      const gerado = auth.gerarCodigo(conta.id, 'alterar-conta', conta.email, { nome, telefone });
      enviarCodigo(conta, conta.email, gerado);

      ctx.ok({
        ok: true,
        precisaCodigo: true,
        destino: conta.email,
        mensagem: 'Enviamos um código para confirmar a alteração.',
        ...devCodigo(gerado)
      });
      return;
    }

    const r = auth.conferirCodigo(conta.id, 'alterar-conta', corpo.codigo);
    if (!r.ok) throw erro400(r.erro);

    const pendente = r.carga || {};
    const nome = texto(pendente.nome, 120) || conta.nome;
    const telefone = texto(pendente.telefone, 40);

    db.executar(
      'UPDATE contas SET nome = ?, telefone = ?, atualizado_em = ? WHERE id = ?',
      nome, telefone || null, db.agora(), conta.id
    );
    regras.registrar(ctx, 'conta', conta.email, 'alterou os dados cadastrais', nome);

    ctx.ok({ ok: true, conta: auth.contaPublica(contaPorId(conta.id)) });
  });

  /**
   * Troca de e-mail, passo 1. O código vai para o endereço ANTIGO (regra do
   * briefing): quem tomou a conta não consegue mudar o endereço sem ter acesso
   * à caixa original. O novo endereço fica em codigos.carga até a confirmação.
   */
  rotas.post('/api/conta/email', async (ctx) => {
    const conta = ctx.exigirLogin();
    const corpo = await ctx.corpo();
    freio(ctx, 'conta-email');

    const novoEmail = normalizarEmail(corpo.novoEmail);
    if (!emailValido(novoEmail)) throw erro400('Informe um e-mail válido.');
    if (novoEmail === String(conta.email).toLowerCase()) {
      throw erro400('O novo e-mail é igual ao atual.');
    }
    if (db.valor('SELECT COUNT(*) FROM contas WHERE lower(email) = ? AND id != ?', novoEmail, conta.id)) {
      throw erro409('Já existe uma conta com este e-mail.');
    }

    const gerado = auth.gerarCodigo(conta.id, 'trocar-email', conta.email, { novoEmail });
    enviarCodigo(conta, conta.email, gerado);

    ctx.ok({
      ok: true,
      destino: conta.email,
      mensagem: 'Enviamos o código para o seu e-mail atual. Confirme para concluir a troca.',
      ...devCodigo(gerado)
    });
  });

  rotas.post('/api/conta/email/confirmar', async (ctx) => {
    const conta = ctx.exigirLogin();
    const corpo = await ctx.corpo();
    freio(ctx, 'conta-email-confirmar');

    const r = auth.conferirCodigo(conta.id, 'trocar-email', corpo.codigo);
    if (!r.ok) throw erro400(r.erro);

    const novoEmail = normalizarEmail((r.carga || {}).novoEmail);
    if (!emailValido(novoEmail)) throw erro400('A troca pendente não é mais válida. Peça a alteração de novo.');

    /* Confere de novo: entre o pedido e a confirmação alguém pode ter criado
       conta com esse endereço. */
    if (db.valor('SELECT COUNT(*) FROM contas WHERE lower(email) = ? AND id != ?', novoEmail, conta.id)) {
      throw erro409('Já existe uma conta com este e-mail.');
    }

    const gerado = db.transacao(() => {
      db.executar(
        'UPDATE contas SET email = ?, email_verificado = 0, atualizado_em = ? WHERE id = ?',
        novoEmail, db.agora(), conta.id
      );

      /* O endereço novo ainda não provou existir: sai um segundo código, agora
         para ele. */
      const codigo = auth.gerarCodigo(conta.id, 'verificar-email', novoEmail);
      enviarCodigo({ ...conta, email: novoEmail }, novoEmail, codigo);

      regras.registrar(ctx, 'conta', conta.email, 'trocou o e-mail da conta', `para ${novoEmail}`);
      return codigo;
    });

    ctx.ok({
      ok: true,
      conta: auth.contaPublica(contaPorId(conta.id)),
      precisaVerificarEmail: true,
      mensagem: 'E-mail alterado. Confirme o código enviado para o novo endereço.',
      ...devCodigo(gerado)
    });
  });

  /* ------------------------------------------------------------------------
     SESSÕES ABERTAS
     ------------------------------------------------------------------------ */

  rotas.get('/api/conta/sessoes', async (ctx) => {
    const conta = ctx.exigirLogin();
    const atual = hashDoToken(ctx.token);

    const linhas = db.todos(
      `SELECT * FROM sessoes
        WHERE conta_id = ? AND expira_em > ?
        ORDER BY visto_em DESC, criado_em DESC`,
      conta.id, db.agora()
    );

    ctx.ok({
      ok: true,
      sessoes: linhas.map((s) => ({
        /* Só o prefixo do hash sai do servidor: identifica a linha para revogar
           sem publicar o que está guardado na tabela. */
        id: s.token_hash.slice(0, IDENT_SESSAO),
        atual: s.token_hash === atual,
        criadoEm: mapa.dataHora(s.criado_em),
        expiraEm: mapa.dataHora(s.expira_em),
        vistoEm: mapa.dataHora(s.visto_em),
        ip: s.ip,
        agente: s.agente
      }))
    });
  });

  rotas.delete('/api/conta/sessoes/:tokenHash', async (ctx) => {
    const conta = ctx.exigirLogin();

    /* Só hexadecimal: o valor entra numa comparação por prefixo, e caractere
       livre aqui viraria curinga. */
    const chave = String(ctx.params.tokenHash || '').toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(chave)) throw erro400('Identificador de sessão inválido.');

    /* O filtro por conta_id é o que impede revogar a sessão de outra pessoa. */
    const alvo = db.um(
      'SELECT token_hash FROM sessoes WHERE conta_id = ? AND substr(token_hash, 1, ?) = ?',
      conta.id, chave.length, chave
    );
    if (!alvo) throw erro400('Sessão não encontrada.');

    db.executar('DELETE FROM sessoes WHERE token_hash = ?', alvo.token_hash);
    regras.registrar(ctx, 'conta', conta.email, 'revogou uma sessão', chave);

    const eraAtual = alvo.token_hash === hashDoToken(ctx.token);
    const cabecalhos = eraAtual ? { 'Set-Cookie': auth.cookieLimpo({ seguro: ctx.seguro }) } : undefined;

    ctx.ok({ ok: true, atual: eraAtual }, cabecalhos);
  });
}

module.exports = { registrar, enviarModelo, renderizar, contextoEmail };
