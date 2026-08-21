/* ==========================================================================
   PHYGITAL BRASIL — AUTENTICAÇÃO E AUTORIZAÇÃO

   Tudo com node:crypto, sem dependência externa.

   Decisões que valem explicar:

   · Senha com scrypt, não SHA. Hash rápido é ruim para senha: quem vaza o
     banco testa bilhões por segundo. scrypt é lento de propósito e custa
     memória, o que também atrapalha ataque em GPU.
   · Sal por conta, para que duas senhas iguais gerem hashes diferentes e uma
     rainbow table não sirva.
   · Comparação em tempo constante (timingSafeEqual): comparar com === vaza,
     pelo tempo de resposta, quantos bytes iniciais acertaram.
   · O token de sessão vai inteiro no cookie, mas no banco fica só o SHA-256.
     Quem ler a tabela sessoes não consegue assumir sessão nenhuma.
   · Cookie HttpOnly (JavaScript da página não lê, então XSS não rouba a
     sessão), SameSite=Lax (barra CSRF vindo de outro site) e Secure quando a
     conexão é HTTPS.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const traducoes = require('./traducoes');

/* Custo do scrypt. N=2^15 com r=8 ≈ 100 ms por hash nesta máquina:
   imperceptível no login, caro para quem tenta força bruta offline.

   maxmem precisa ser declarado: scrypt consome 128 * N * r bytes (aqui 33,5 MB)
   e o limite padrão do OpenSSL é 32 MB, o que faria scryptSync lançar
   ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Como scryptSync é bloqueante, os logins
   serializam no event loop e o pico de memória é o de um hash só. */
const SCRYPT = { N: 32768, r: 8, p: 1, tamanho: 64, maxmem: 96 * 1024 * 1024 };

const SESSAO_HORAS = 12;
const CODIGO_MINUTOS = 15;
const CODIGO_MAX_TENTATIVAS = 5;

/* Freio de força bruta: 8 falhas em 15 minutos bloqueiam a chave. */
const LOGIN_JANELA_MIN = 15;
const LOGIN_MAX_FALHAS = 8;

const NOME_COOKIE = 'phygital_sessao';

/* --------------------------------------------------------------------------
   SENHA
   -------------------------------------------------------------------------- */

function gerarSal() {
  return crypto.randomBytes(16).toString('hex');
}

function hashSenha(senha, sal) {
  return crypto
    .scryptSync(String(senha), sal, SCRYPT.tamanho,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem })
    .toString('hex');
}

function criarSenha(senha) {
  const sal = gerarSal();
  return { senha_salt: sal, senha_hash: hashSenha(senha, sal) };
}

function senhaConfere(senha, hashGuardado, sal) {
  const calculado = Buffer.from(hashSenha(senha, sal), 'hex');
  const guardado = Buffer.from(String(hashGuardado), 'hex');
  if (calculado.length !== guardado.length) return false;
  return crypto.timingSafeEqual(calculado, guardado);
}

/**
 * Política mínima de senha. Devolve lista de problemas (vazia = aprovada).
 * Deliberadamente sem exigência de símbolo: comprimento protege mais que
 * variedade de caracteres, e regra complicada empurra o usuário para senha
 * previsível anotada num papel.
 */
function avaliarSenha(senha, contexto = {}) {
  const s = String(senha || '');
  const erros = [];

  if (s.length < 10) erros.push('A senha precisa de pelo menos 10 caracteres.');
  if (!/[a-zA-Z]/.test(s)) erros.push('Inclua ao menos uma letra.');
  if (!/[0-9]/.test(s)) erros.push('Inclua ao menos um número.');

  const obvias = ['phygital', 'senha', 'password', '123456', 'qwerty', 'brasil'];
  const min = s.toLowerCase();
  if (obvias.some((o) => min.includes(o))) {
    erros.push('Evite palavras óbvias como "phygital", "senha" ou sequências de teclado.');
  }
  if (contexto.email) {
    const usuario = String(contexto.email).split('@')[0].toLowerCase();
    if (usuario.length >= 4 && min.includes(usuario)) {
      erros.push('A senha não pode conter o seu e-mail.');
    }
  }
  if (contexto.nome) {
    const primeiro = String(contexto.nome).trim().split(/\s+/)[0].toLowerCase();
    if (primeiro.length >= 4 && min.includes(primeiro)) {
      erros.push('A senha não pode conter o seu nome.');
    }
  }

  return erros;
}

/* --------------------------------------------------------------------------
   FREIO DE FORÇA BRUTA
   -------------------------------------------------------------------------- */

function registrarTentativa(chave, sucesso) {
  db.executar(
    'INSERT INTO tentativas_login (chave, sucesso, em) VALUES (?, ?, ?)',
    String(chave || '?'), sucesso ? 1 : 0, db.agora()
  );
}

function falhasRecentes(chave) {
  const desde = new Date(Date.now() - LOGIN_JANELA_MIN * 60000).toISOString();
  return db.valor(
    'SELECT COUNT(*) FROM tentativas_login WHERE chave = ? AND sucesso = 0 AND em > ?',
    String(chave || '?'), desde
  ) || 0;
}

function bloqueado(chave, max = LOGIN_MAX_FALHAS) {
  return falhasRecentes(chave) >= max;
}

function limparTentativas(chave) {
  db.executar('DELETE FROM tentativas_login WHERE chave = ?', String(chave || '?'));
}

/* --------------------------------------------------------------------------
   SESSÃO
   -------------------------------------------------------------------------- */

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function abrirSessao(contaId, { ip, agente } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const criado = new Date();
  const expira = new Date(criado.getTime() + SESSAO_HORAS * 3600000);

  db.executar(
    `INSERT INTO sessoes (token_hash, conta_id, criado_em, expira_em, visto_em, ip, agente)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    hashToken(token), contaId, criado.toISOString(), expira.toISOString(),
    criado.toISOString(), ip || null, agente || null
  );

  return { token, expira };
}

/** Devolve a conta da sessão, ou null. Renova visto_em e limpa o que expirou. */
function contaDaSessao(token) {
  if (!token) return null;

  const sessao = db.um(
    'SELECT * FROM sessoes WHERE token_hash = ?', hashToken(token)
  );
  if (!sessao) return null;

  if (new Date(sessao.expira_em) <= new Date()) {
    db.executar('DELETE FROM sessoes WHERE token_hash = ?', sessao.token_hash);
    return null;
  }

  const conta = db.um(
    'SELECT * FROM contas WHERE id = ? AND arquivado_em IS NULL', sessao.conta_id
  );
  if (!conta) return null;

  db.executar('UPDATE sessoes SET visto_em = ? WHERE token_hash = ?', db.agora(), sessao.token_hash);
  return conta;
}

function encerrarSessao(token) {
  if (!token) return;
  db.executar('DELETE FROM sessoes WHERE token_hash = ?', hashToken(token));
}

/** Usado na troca de senha: derruba todas as sessões da conta. */
function encerrarTodasAsSessoes(contaId) {
  db.executar('DELETE FROM sessoes WHERE conta_id = ?', contaId);
}

function limparSessoesExpiradas() {
  return db.executar('DELETE FROM sessoes WHERE expira_em <= ?', db.agora()).changes;
}

/* --------------------------------------------------------------------------
   CÓDIGOS DE VERIFICAÇÃO

   Seis dígitos, hash no banco, uso único, expiração e limite de tentativas.
   O código em claro só existe no retorno desta função — quem chama manda por
   e-mail e esquece.
   -------------------------------------------------------------------------- */

function gerarCodigo(contaId, finalidade, destino, carga = null) {
  /* randomInt é criptograficamente seguro; Math.random não seria. */
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expira = new Date(Date.now() + CODIGO_MINUTOS * 60000).toISOString();

  /* Um código novo invalida os anteriores da mesma finalidade. */
  db.executar(
    'DELETE FROM codigos WHERE conta_id = ? AND finalidade = ? AND usado_em IS NULL',
    contaId, finalidade
  );

  db.executar(
    `INSERT INTO codigos (id, conta_id, finalidade, codigo_hash, destino, carga,
                          expira_em, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(), contaId, finalidade, hashToken(codigo),
    destino, db.paraJson(carga), expira, db.agora()
  );

  return { codigo, expira, minutos: CODIGO_MINUTOS };
}

function conferirCodigo(contaId, finalidade, codigo) {
  const reg = db.um(
    `SELECT * FROM codigos
      WHERE conta_id = ? AND finalidade = ? AND usado_em IS NULL
      ORDER BY criado_em DESC LIMIT 1`,
    contaId, finalidade
  );

  if (!reg) return { ok: false, erro: 'Nenhum código pendente. Peça um novo.' };

  if (new Date(reg.expira_em) <= new Date()) {
    return { ok: false, erro: 'O código expirou. Peça um novo.' };
  }
  if (reg.tentativas >= CODIGO_MAX_TENTATIVAS) {
    return { ok: false, erro: 'Muitas tentativas. Peça um novo código.' };
  }

  const informado = Buffer.from(hashToken(String(codigo).trim()), 'hex');
  const guardado = Buffer.from(reg.codigo_hash, 'hex');
  const confere = informado.length === guardado.length
    && crypto.timingSafeEqual(informado, guardado);

  if (!confere) {
    db.executar('UPDATE codigos SET tentativas = tentativas + 1 WHERE id = ?', reg.id);
    const restantes = CODIGO_MAX_TENTATIVAS - (reg.tentativas + 1);
    return {
      ok: false,
      erro: restantes > 0
        ? `Código incorreto. ${restantes} tentativa(s) restante(s).`
        : 'Código incorreto. Peça um novo código.'
    };
  }

  db.executar('UPDATE codigos SET usado_em = ? WHERE id = ?', db.agora(), reg.id);
  return { ok: true, carga: db.json(reg.carga), destino: reg.destino };
}

/* --------------------------------------------------------------------------
   AUTORIZAÇÃO POR PAPEL

   master   → tudo
   gestor   → lê campeonatos, exporta e envia e-mail; não escreve
   operacao → atende chamados
   -------------------------------------------------------------------------- */

const PERMISSOES = {
  master: ['*'],
  gestor: [
    'campeonatos:ler', 'campeonatos:exportar', 'inscricoes:ler',
    'times:ler', 'ranking:ler', 'email:enviar', 'chamados:ler', 'blog:ler',
    'auditoria:ler'
  ],
  operacao: [
    'campeonatos:ler', 'inscricoes:ler', 'times:ler', 'ranking:ler',
    'chamados:ler', 'chamados:responder', 'blog:ler'
  ]
};

function podeFazer(conta, permissao) {
  if (!conta) return false;
  if (conta.papel !== 'admin') return false;
  const lista = PERMISSOES[conta.nivel] || [];
  return lista.includes('*') || lista.includes(permissao);
}

/** Remove hash, sal e tudo que não deve sair do servidor. */
function contaPublica(conta) {
  if (!conta) return null;
  return {
    id: conta.id,
    nome: conta.nome,
    email: conta.email,
    telefone: conta.telefone,
    papel: conta.papel,
    nivel: conta.nivel,
    /* Banco antigo, antes da migração da coluna, não traz o campo. */
    idioma: traducoes.normalizarOuPadrao(conta.idioma),
    emailVerificado: db.bool(conta.email_verificado),
    senhaProvisoria: db.bool(conta.senha_provisoria),
    criadoEm: conta.criado_em,
    ultimoAcessoEm: conta.ultimo_acesso_em,
    /* Para onde o front-end manda o usuário depois do login. */
    destino: conta.papel === 'admin' ? '../admin/index.html' : 'inicio.html'
  };
}

/* --------------------------------------------------------------------------
   LOGIN
   -------------------------------------------------------------------------- */

function autenticar(email, senha, { ip, agente } = {}) {
  const normalizado = String(email || '').trim().toLowerCase();

  if (bloqueado(ip) || bloqueado(normalizado)) {
    return {
      ok: false,
      codigo: 'bloqueado',
      erro: `Muitas tentativas. Aguarde ${LOGIN_JANELA_MIN} minutos e tente novamente.`
    };
  }

  const conta = db.um(
    'SELECT * FROM contas WHERE lower(email) = ? AND arquivado_em IS NULL', normalizado
  );

  /* Mesmo sem a conta existir, gastamos o tempo de um scrypt. Sem isso, a
     diferença de tempo de resposta revela quais e-mails têm conta. */
  if (!conta) {
    hashSenha(String(senha || ''), 'sal-inexistente-para-igualar-o-tempo');
    registrarTentativa(ip, false);
    registrarTentativa(normalizado, false);
    return { ok: false, codigo: 'credenciais', erro: 'E-mail ou senha incorretos.' };
  }

  if (!senhaConfere(senha, conta.senha_hash, conta.senha_salt)) {
    registrarTentativa(ip, false);
    registrarTentativa(normalizado, false);
    return { ok: false, codigo: 'credenciais', erro: 'E-mail ou senha incorretos.' };
  }

  registrarTentativa(ip, true);
  limparTentativas(normalizado);
  db.executar('UPDATE contas SET ultimo_acesso_em = ? WHERE id = ?', db.agora(), conta.id);

  const sessao = abrirSessao(conta.id, { ip, agente });

  return {
    ok: true,
    conta: contaPublica(conta),
    token: sessao.token,
    expira: sessao.expira,
    /* Sinaliza os dois desvios obrigatórios do briefing. */
    precisaTrocarSenha: db.bool(conta.senha_provisoria),
    precisaVerificarEmail: !db.bool(conta.email_verificado)
  };
}

/* --------------------------------------------------------------------------
   COOKIE
   -------------------------------------------------------------------------- */

function cookieSessao(token, { seguro = false, expira } = {}) {
  const partes = [
    `${NOME_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (expira) partes.push(`Expires=${new Date(expira).toUTCString()}`);
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

function cookieLimpo({ seguro = false } = {}) {
  const partes = [`${NOME_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

module.exports = {
  NOME_COOKIE, SESSAO_HORAS, CODIGO_MINUTOS,
  criarSenha, hashSenha, senhaConfere, avaliarSenha,
  autenticar, abrirSessao, contaDaSessao, encerrarSessao,
  encerrarTodasAsSessoes, limparSessoesExpiradas,
  gerarCodigo, conferirCodigo,
  podeFazer, contaPublica, PERMISSOES,
  bloqueado, registrarTentativa, limparTentativas,
  cookieSessao, cookieLimpo
};
