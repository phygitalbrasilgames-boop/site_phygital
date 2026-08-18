/* ==========================================================================
   ENVIO DE ARQUIVO — POST /api/upload

   O que a rota promete: só administrador com 'banners:escrever' grava; o tipo
   sai da assinatura do arquivo, não da extensão; o nome de disco é gerado aqui
   e o do cliente nunca vira caminho; e o que passa fica servível em
   /assets/enviados/ com o Content-Type certo.

   Este arquivo escreve na pasta de verdade (site/assets/enviados/), porque é
   ela que o servidor de estáticos publica — não dá para desviar para o banco
   temporário sem deixar de testar o caminho que o navegador usa. Tudo o que é
   criado aqui volta a ser apagado no `after`.
   ========================================================================== */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const amb = require('../apoio/ambiente');

const upload = require(path.join(amb.RAIZ, 'server', 'rotas', 'upload'));

/* Nomes gravados durante a suíte, para a faxina do fim. */
const criados = [];

/* --------------------------------------------------------------------------
   ARQUIVOS DE MENTIRA

   Montados em Buffer, byte a byte: é exatamente o que a rota inspeciona.
   -------------------------------------------------------------------------- */

/** PNG com IHDR de verdade, para as dimensões terem o que ler. */
function png(largura = 800, altura = 450, recheio = 64) {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const bloco = Buffer.alloc(25);          /* tamanho(4) + 'IHDR'(4) + dados(13) + crc(4) */
  bloco.writeUInt32BE(13, 0);
  bloco.write('IHDR', 4, 'latin1');
  bloco.writeUInt32BE(largura, 8);
  bloco.writeUInt32BE(altura, 12);
  bloco[16] = 8;                           /* profundidade de bits */
  bloco[17] = 6;                           /* cor: RGBA */

  return Buffer.concat([assinatura, bloco, Buffer.alloc(recheio, 0x5a)]);
}

/** WEBM: só o cabeçalho EBML importa para a lista branca. */
const webm = (recheio = 256) => Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(recheio, 0x11)
]);

/** MP4: quatro bytes de tamanho de caixa e a marca 'ftyp' no quinto. */
const mp4 = (recheio = 256) => Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(recheio, 0x22)
]);

/* --------------------------------------------------------------------------
   MULTIPART

   O envelope que um <input type="file"> produz, montado à mão para o teste
   exercitar o mesmo analisador que o navegador vai exercitar.
   -------------------------------------------------------------------------- */

function multipart(campos) {
  const limite = `----ProvaPhygital${Math.random().toString(36).slice(2)}`;
  const pedacos = [];

  for (const campo of campos) {
    let cabecalho = `--${limite}\r\nContent-Disposition: form-data; name="${campo.nome}"`;
    if (campo.arquivo !== undefined) cabecalho += `; filename="${campo.arquivo}"`;
    cabecalho += '\r\n';
    if (campo.tipo) cabecalho += `Content-Type: ${campo.tipo}\r\n`;
    cabecalho += '\r\n';

    pedacos.push(Buffer.from(cabecalho, 'utf8'));
    pedacos.push(Buffer.isBuffer(campo.dados) ? campo.dados : Buffer.from(String(campo.dados), 'utf8'));
    pedacos.push(Buffer.from('\r\n', 'utf8'));
  }

  pedacos.push(Buffer.from(`--${limite}--\r\n`, 'utf8'));

  return {
    corpo: Buffer.concat(pedacos),
    cabecalhos: { 'content-type': `multipart/form-data; boundary=${limite}` }
  };
}

/** Envia um arquivo como formulário, do jeito que a tela envia. */
function enviarFormulario(cliente, dados, nomeArquivo = 'banner.png', tipo = 'image/png') {
  const envelope = multipart([
    { nome: 'origem', dados: 'banners-site' },      /* campo comum, que a rota deve ignorar */
    { nome: 'arquivo', arquivo: nomeArquivo, tipo, dados }
  ]);
  return cliente.post('/api/upload', envelope.corpo, { cabecalhos: envelope.cabecalhos });
}

/** Envia o mesmo arquivo como corpo binário cru. */
function enviarCru(cliente, dados, tipo, nomeArquivo) {
  return cliente.post('/api/upload', dados, {
    cabecalhos: { 'content-type': tipo, 'x-nome-arquivo': nomeArquivo }
  });
}

const noDisco = (nome) => path.join(upload.PASTA, nome);

describe('envio de arquivo', () => {
  let mestre;

  before(() => { mestre = amb.comoMaster(); });

  after(() => {
    for (const nome of criados) {
      try { fs.unlinkSync(noDisco(nome)); } catch (_) { /* já apagado pelo próprio teste */ }
    }
  });

  /* ------------------------------------------------------------------------
     CAMINHO FELIZ
     ------------------------------------------------------------------------ */

  it('o PNG entra, ganha nome novo e fica servível em /assets/enviados/', async () => {
    const r = await enviarFormulario(mestre, png(800, 450));

    assert.equal(r.status, 200);
    assert.equal(r.corpo.ok, true);
    assert.equal(r.corpo.tipo, 'image/png');
    assert.equal(r.corpo.tamanho, png(800, 450).length);
    /* As dimensões saem do IHDR: é o que a tela usa para avisar que a imagem é
       pequena demais para um hero. */
    assert.equal(r.corpo.largura, 800);
    assert.equal(r.corpo.altura, 450);

    criados.push(r.corpo.nome);

    assert.match(r.corpo.caminho, /^assets\/enviados\/[0-9a-f-]{36}\.png$/);
    /* O nome escolhido pelo cliente vira metadado e nada mais. */
    assert.equal(r.corpo.original, 'banner.png');
    assert.ok(fs.existsSync(noDisco(r.corpo.nome)));

    /* O que interessa no fim: o navegador consegue buscar o arquivo. */
    const servido = await amb.anonimo().get(`/${r.corpo.caminho}`);
    assert.equal(servido.status, 200);
    assert.equal(servido.cabecalhos.get('content-type'), 'image/png');
  });

  it('o corpo binário cru também é aceito, com o nome no cabeçalho', async () => {
    const r = await enviarCru(mestre, png(1920, 1080), 'image/png', 'abertura 2026.png');

    assert.equal(r.status, 200);
    criados.push(r.corpo.nome);

    assert.equal(r.corpo.largura, 1920);
    assert.equal(r.corpo.original, 'abertura 2026.png');
  });

  it('o vídeo é servido com o Content-Type que o <video> precisa', async () => {
    const doWebm = await enviarFormulario(mestre, webm(), 'abertura.webm', 'video/webm');
    assert.equal(doWebm.status, 200);
    assert.equal(doWebm.corpo.tipo, 'video/webm');
    assert.equal(doWebm.corpo.classe, 'video');
    criados.push(doWebm.corpo.nome);

    const servidoWebm = await amb.anonimo().get(`/${doWebm.corpo.caminho}`);
    assert.equal(servidoWebm.cabecalhos.get('content-type'), 'video/webm');

    const doMp4 = await enviarCru(mestre, mp4(), 'video/mp4', 'abertura.mp4');
    assert.equal(doMp4.status, 200);
    assert.equal(doMp4.corpo.tipo, 'video/mp4');
    criados.push(doMp4.corpo.nome);

    const servidoMp4 = await amb.anonimo().get(`/${doMp4.corpo.caminho}`);
    assert.equal(servidoMp4.cabecalhos.get('content-type'), 'video/mp4');
  });

  it('o caminho devolvido é aceito como imagem de banner do site', async () => {
    const enviado = await enviarFormulario(mestre, png());
    criados.push(enviado.corpo.nome);

    /* O elo que fechava com blob:// e não sobrevivia ao recarregamento: o
       caminho relativo passa pelo validador de endereço de conteudo.js. */
    const banner = await mestre.post('/api/banners-site', {
      titulo: 'Hero com arquivo enviado', midia: 'imagem', img: enviado.corpo.caminho
    });

    assert.equal(banner.status, 200);
    assert.equal(banner.corpo.bannerSite.img, enviado.corpo.caminho);
  });

  /* ------------------------------------------------------------------------
     ASSINATURA
     ------------------------------------------------------------------------ */

  it('extensão .png com texto dentro é recusada', async () => {
    const disfarcado = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');

    const r = await enviarFormulario(mestre, disfarcado, 'inocente.png', 'image/png');
    assert.equal(r.status, 400, 'a extensão e o Content-Type vêm do cliente e não valem nada');

    /* Nada pode ter sido gravado por um envio recusado. */
    const naPasta = fs.existsSync(upload.PASTA) ? fs.readdirSync(upload.PASTA) : [];
    assert.ok(!naPasta.some((n) => n.endsWith('.php') || n === 'inocente.png'));
  });

  it('SVG e outros formatos fora da lista branca não passam', async () => {
    /* SVG carrega <script>: fica de fora de propósito, ainda que seja imagem. */
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');

    assert.equal((await enviarFormulario(mestre, svg, 'logo.svg', 'image/svg+xml')).status, 400);
    assert.equal((await enviarCru(mestre, Buffer.from('PKzip'), 'application/zip', 'a.zip')).status, 400);
  });

  /* ------------------------------------------------------------------------
     TRAVESSIA DE DIRETÓRIO
     ------------------------------------------------------------------------ */

  it('nome com "../" não escapa da pasta de enviados', async () => {
    const alvo = path.join(amb.RAIZ, 'server', 'index.js');
    const antes = fs.readFileSync(alvo);

    const r = await enviarFormulario(mestre, png(), '../../server/index.js', 'image/png');

    assert.equal(r.status, 200, 'o arquivo é válido: o que precisa ser ignorado é o nome');
    criados.push(r.corpo.nome);

    /* O nome enviado foi descartado inteiro — inclusive a extensão, que vem da
       assinatura. */
    assert.match(r.corpo.nome, /^[0-9a-f-]{36}\.png$/);
    assert.equal(r.corpo.caminho, `assets/enviados/${r.corpo.nome}`);

    const gravado = path.resolve(upload.PASTA, r.corpo.nome);
    assert.ok(gravado.startsWith(upload.PASTA + path.sep), 'o arquivo tem que ficar dentro da pasta');
    assert.ok(fs.existsSync(gravado));

    assert.deepEqual(fs.readFileSync(alvo), antes, 'server/index.js não podia ter sido tocado');
  });

  /* ------------------------------------------------------------------------
     TETO
     ------------------------------------------------------------------------ */

  it('imagem acima de 5 MB é recusada', async () => {
    const gorda = Buffer.concat([png(), Buffer.alloc(upload.TETOS.imagem, 0x77)]);

    const r = await enviarFormulario(mestre, gorda, 'enorme.png', 'image/png');
    assert.equal(r.status, 413);

    /* O teto de vídeo é mais alto, mas não vale para imagem: uma folga comum
       transformaria a rota em depósito. */
    assert.ok(upload.TETOS.video > upload.TETOS.imagem);
  });

  /* ------------------------------------------------------------------------
     PERMISSÃO
     ------------------------------------------------------------------------ */

  it('competidor recebe 403 e anônimo recebe 401', async () => {
    const doCompetidor = await enviarFormulario(amb.comoCompetidor(), png());
    assert.equal(doCompetidor.status, 403);

    const deNinguem = await enviarFormulario(amb.anonimo(), png());
    assert.equal(deNinguem.status, 401);

    /* 'banners:escrever' não está nas listas de gestor nem de operação. */
    const doGestor = await enviarFormulario(amb.comoGestor(), png());
    assert.equal(doGestor.status, 403);
  });

  /* ------------------------------------------------------------------------
     EXCLUSÃO
     ------------------------------------------------------------------------ */

  it('o DELETE apaga o arquivo e só aceita nome no formato gerado aqui', async () => {
    const enviado = await enviarFormulario(mestre, png());
    const nome = enviado.corpo.nome;
    assert.ok(fs.existsSync(noDisco(nome)));

    const torto = await mestre.apagar('/api/upload/..%2F..%2Fserver%2Findex.js');
    assert.equal(torto.status, 400);
    assert.ok(fs.existsSync(path.join(amb.RAIZ, 'server', 'index.js')));

    assert.equal((await mestre.apagar('/api/upload/hero-1.svg')).status, 400);

    const inexistente = await mestre.apagar(
      '/api/upload/00000000-0000-4000-8000-000000000000.png'
    );
    assert.equal(inexistente.status, 404);

    assert.equal((await amb.comoCompetidor().apagar(`/api/upload/${nome}`)).status, 403);
    assert.ok(fs.existsSync(noDisco(nome)), '403 não pode apagar nada');

    const apagado = await mestre.apagar(`/api/upload/${nome}`);
    assert.equal(apagado.status, 200);
    assert.ok(!fs.existsSync(noDisco(nome)));
  });

  it('cada envio deixa registro na auditoria', async () => {
    const enviado = await enviarFormulario(mestre, png(), 'para-auditoria.png');
    criados.push(enviado.corpo.nome);

    const linha = amb.db.um(
      "SELECT * FROM auditoria WHERE acao = 'enviou arquivo' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(linha, 'o envio de arquivo precisa aparecer na trilha do administrador');
    assert.equal(linha.alvo, 'para-auditoria.png');
  });
});
