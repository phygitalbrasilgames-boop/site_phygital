#!/usr/bin/env node
/*
 * Servidor local do site Phygital Brasil — versão Node.
 *
 * Mesmo comportamento do servidor.py: envia Cache-Control: no-store em tudo,
 * porque sem isso o navegador guarda o CSS e o JavaScript antigos e as
 * alterações não aparecem sem limpar o cache na mão.
 *
 * Existe porque o Windows não traz Python instalado. Em máquinas com Python,
 * servidor.py faz exatamente a mesma coisa.
 *
 * Uso:  node servidor.js [porta]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, 'site');

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
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
};

function servir(req, res) {
  let caminho = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (caminho.endsWith('/')) caminho += 'index.html';

  const alvo = path.join(RAIZ, path.normalize(caminho));

  /* Impede sair da pasta site/ por ../ na URL */
  if (!alvo.startsWith(RAIZ)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(alvo, (erro, dados) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>' + caminho + '</p>');
      console.log('404', caminho);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(dados);
  });
}

function subir(porta, tentativasRestantes) {
  const servidor = http.createServer(servir);

  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tentativasRestantes > 0) {
      subir(porta + 1, tentativasRestantes - 1);
    } else {
      console.error('Não foi possível subir o servidor:', e.message);
      process.exit(1);
    }
  });

  servidor.listen(porta, () => {
    const url = 'http://localhost:' + porta;
    console.log('');
    console.log('  ██  PHYGITAL BRASIL — SERVIDOR LOCAL');
    console.log('  ' + '─'.repeat(48));
    console.log('  Site:              ' + url);
    console.log('  Painel Competidor: ' + url + '/painel/');
    console.log('  Painel Admin:      ' + url + '/admin/');
    console.log('  ' + '─'.repeat(48));
    console.log('  Cache desativado: basta recarregar a página (Ctrl+R)');
    console.log('  Para parar: Ctrl+C');
    console.log('');
  });
}

if (!fs.existsSync(RAIZ)) {
  console.error("Pasta 'site' não encontrada em " + RAIZ);
  process.exit(1);
}

const pedida = parseInt(process.argv[2], 10);
subir(Number.isInteger(pedida) ? pedida : 8080, 12);
