#!/usr/bin/env node
/* ==========================================================================
   PHYGITAL BRASIL — SERVIDOR

   Um processo serve as duas coisas:
     · a API em /api/*
     · os arquivos de site/ em todo o resto

   Servir o front-end do mesmo host tem uma consequência boa de segurança: sem
   requisição cruzada, o cookie SameSite=Lax basta e não precisa de CORS aberto.

   Uso:  node server/index.js [porta]

   Ambiente:
     PHYGITAL_PORTA           porta (padrão 3000; o argumento tem prioridade)
     PHYGITAL_MODO            'dev' (padrão) | 'producao'
     PHYGITAL_DADOS           pasta do banco (padrão ./dados)
     PHYGITAL_ADMIN_SENHA     senha da conta master na primeira semeadura
     PHYGITAL_COMPETIDOR_SENHA
     PHYGITAL_SMTP_SENHA      liga o envio real de e-mail; sem ela, simulado
     PHYGITAL_SMTP_CERT_INVALIDO
                              aceita certificado próprio no SMTP (só ambiente
                              interno; em produção derruba a proteção do TLS)
   ========================================================================== */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const auth = require('./auth');
const web = require('./http');
const filaEmail = require('./fila-email');

const RAIZ = path.join(__dirname, '..');
const ESTATICOS = path.join(RAIZ, 'site');
const MODO = process.env.PHYGITAL_MODO || 'dev';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
};

/* --------------------------------------------------------------------------
   ROTAS

   Cada módulo exporta registrar(rotas). Carregamos um por um e seguimos em
   frente se algum falhar: durante o desenvolvimento, um módulo com erro de
   sintaxe não deve derrubar o servidor inteiro e esconder o resto. O que
   carregou e o que falhou fica visível em /api/_saude.
   -------------------------------------------------------------------------- */

const MODULOS = [
  'bootstrap', 'auth', 'campeonatos', 'times',
  'inscricoes', 'chamados', 'conteudo', 'admin', 'email'
];

const rotas = web.criarRoteador();
const carregados = [];
const falhados = [];

for (const nome of MODULOS) {
  const caminho = path.join(__dirname, 'rotas', `${nome}.js`);
  if (!fs.existsSync(caminho)) {
    falhados.push({ modulo: nome, erro: 'arquivo não encontrado' });
    continue;
  }
  try {
    require(caminho).registrar(rotas);
    carregados.push(nome);
  } catch (e) {
    falhados.push({ modulo: nome, erro: e.message });
    console.error(`[rotas] falha em ${nome}: ${e.message}`);
  }
}

rotas.get('/api/_saude', async (ctx) => ctx.ok({
  ok: true,
  modo: MODO,
  banco: db.ARQUIVO,
  rotasRegistradas: rotas.total,
  modulosCarregados: carregados,
  modulosComFalha: falhados
}));

/* --------------------------------------------------------------------------
   ESTÁTICOS
   -------------------------------------------------------------------------- */

function servirEstatico(req, res, caminhoUrl) {
  let relativo = decodeURIComponent(caminhoUrl);
  if (relativo.endsWith('/')) relativo += 'index.html';

  /* path.normalize resolve os '..' ANTES da checagem; sem isso,
     /../../etc/passwd sairia da pasta do site. */
  const alvo = path.join(ESTATICOS, path.normalize(relativo));
  if (!alvo.startsWith(ESTATICOS)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(alvo, (erro, dados) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>404</h1><p>${relativo}</p>`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream',
      /* Sem cache em desenvolvimento: senão o navegador serve CSS e JS antigos
         e a alteração não aparece. */
      'Cache-Control': MODO === 'producao' ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(dados);
  });
}

/* --------------------------------------------------------------------------
   CABEÇALHOS DE SEGURANÇA
   -------------------------------------------------------------------------- */

function cabecalhosSeguranca(res) {
  /* Impede o site ser embutido em iframe de outro domínio (clickjacking). */
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  /* O CSS carrega as fontes do Google Fonts por @import, então fonts.googleapis
     e fonts.gstatic precisam estar liberados em style-src e font-src. */
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
}

/* --------------------------------------------------------------------------
   ATENDIMENTO
   -------------------------------------------------------------------------- */

async function atender(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  cabecalhosSeguranca(res);

  if (!url.pathname.startsWith('/api/')) {
    servirEstatico(req, res, url.pathname);
    return;
  }

  const ctx = web.criarContexto(req, res, url);

  try {
    web.conferirOrigem(req);

    const achado = rotas.achar(req.method, url.pathname);

    if (!achado) throw web.erro404(`Rota não encontrada: ${req.method} ${url.pathname}`);
    if (achado.metodoErrado) {
      throw new web.ErroHttp(405, `Método ${req.method} não é aceito em ${url.pathname}.`);
    }

    ctx.params = achado.params;
    await achado.handler(ctx);

    /* Handler que esqueceu de responder deixaria a conexão pendurada. */
    if (!res.headersSent) {
      throw new web.ErroHttp(500, 'A rota não produziu resposta.');
    }
  } catch (e) {
    if (!res.headersSent) web.falha(res, e);
    else res.end();
  }
}

/* --------------------------------------------------------------------------
   SUBIDA
   -------------------------------------------------------------------------- */

function subir(porta, tentativas) {
  const servidor = http.createServer((req, res) => {
    atender(req, res).catch((e) => {
      console.error('[erro não tratado]', e);
      if (!res.headersSent) web.falha(res, e);
    });
  });

  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tentativas > 0) {
      subir(porta + 1, tentativas - 1);
    } else {
      console.error('Não foi possível subir o servidor:', e.message);
      process.exit(1);
    }
  });

  servidor.listen(porta, () => {
    /* O despachante da fila de e-mail só sobe com o servidor: ele fala com o
       SMTP fora de qualquer transação e precisa da mesma vida útil do processo.
       Sem configuração utilizável cada rodada não faz nada, então ligar sempre
       é seguro — e cobre o caso de a configuração ser corrigida no painel. */
    filaEmail.iniciarDespachante({ intervaloMs: 60000 });
    const envio = filaEmail.resumoConfiguracao();

    const url = `http://localhost:${porta}`;
    const linha = '─'.repeat(52);
    console.log('');
    console.log('  ██  PHYGITAL BRASIL — SERVIDOR NODE');
    console.log('  ' + linha);
    console.log(`  Site:              ${url}`);
    console.log(`  Painel Competidor: ${url}/painel/`);
    console.log(`  Painel Admin:      ${url}/admin/`);
    console.log(`  API:               ${url}/api/_saude`);
    console.log('  ' + linha);
    console.log(`  Modo:   ${MODO}`);
    console.log(`  Banco:  ${db.ARQUIVO}`);
    console.log(`  Rotas:  ${rotas.total} em ${carregados.length} módulo(s)`);
    /* Nunca imprimimos a configuração inteira: ela carrega a senha. */
    console.log(envio.ok
      ? `  E-mail: ENVIO REAL por ${envio.host}:${envio.porta}`
        + ` (${envio.seguro ? 'TLS implícito' : 'STARTTLS'}) como ${envio.remetente}`
      : `  E-mail: SIMULADO — ${envio.motivo}`);
    if (falhados.length) {
      console.log(`  ATENÇÃO: ${falhados.length} módulo(s) com falha:`);
      falhados.forEach((f) => console.log(`     · ${f.modulo}: ${f.erro}`));
    }
    console.log('  ' + linha);
    console.log('  Para parar: Ctrl+C');
    console.log('');
  });

  /* Faxina periódica das sessões vencidas. unref para o timer não segurar o
     processo vivo no encerramento. */
  const faxina = setInterval(() => {
    try { auth.limparSessoesExpiradas(); } catch (_) { /* banco pode estar fechando */ }
  }, 3600000);
  faxina.unref();

  const encerrar = () => {
    console.log('\nEncerrando…');
    /* Antes de fechar o banco: uma rodada em curso escreveria numa conexão
       morta e o que estiver na fila continua lá para a próxima subida. */
    filaEmail.pararDespachante();
    servidor.close(() => { db.fechar(); process.exit(0); });
    /* Se alguma conexão não fechar, não ficamos presos para sempre. */
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  return servidor;
}

if (require.main === module) {
  const argumento = parseInt(process.argv[2], 10);
  const porta = Number.isInteger(argumento)
    ? argumento
    : parseInt(process.env.PHYGITAL_PORTA, 10) || 3000;

  db.abrir();

  /* Banco vazio na primeira subida: semeia sozinho para o site não abrir em
     branco e o desenvolvedor não precisar de um passo extra. */
  const contas = db.valor('SELECT COUNT(*) FROM contas');
  if (!contas) {
    console.log('Banco vazio — semeando dados de demonstração…');
    try {
      require('./semente').semear({});
    } catch (e) {
      console.error('Falha ao semear:', e.message);
    }
  }

  subir(porta, 12);
}

module.exports = { atender, subir, rotas, MODULOS, carregados, falhados };
