/* ==========================================================================
   ANEXO DE E-MAIL — o caminho completo do disco ao SMTP

   O que este arquivo prova, em ordem:

   · o metadado com `caminho` válido vira gravação com bytes anexados de
     verdade — o dispatcher lê o arquivo em site/assets/enviados/ e o servidor
     SMTP falso recebe o multipart/mixed com o Buffer inteiro no fim;
   · caminho fora do padrão é DESCARTADO pela rota, e o disparo segue sem
     esse anexo (nada de derrubar o comunicado inteiro por um metadado torto);
   · arquivo sumido do disco vira falha limpa da linha, não exceção;
   · envio sem anexo continua idêntico ao que era (regressão).

   Este arquivo depende dos mesmos truques de 10-smtp.js: aponta o banco para
   um servidor SMTP falso em 127.0.0.1, injeta uma senha de mentira em
   PHYGITAL_SMTP_SENHA e libera envio real (PHYGITAL_EMAIL_REAL=1). Nada sai
   da máquina.

   Escreve arquivos em site/assets/enviados/ (a pasta real, porque é ela que
   /api/upload grava e o dispatcher lê). Todos são apagados no `after`.
   ========================================================================== */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const amb = require('../apoio/ambiente');
const falso = require('../apoio/smtp-falso');

const email = require(path.join(amb.RAIZ, 'server', 'email'));
const fila = require(path.join(amb.RAIZ, 'server', 'fila-email'));

const db = amb.db;

const CRLF = '\r\n';

/* Mesmas constantes de 10-smtp.js — senha e usuário só existem em memória. */
const USUARIO = 'inscricoes@phygitalgamesbr.com.br';
const SENHA = 'Tr1color-Fita-2026-secreta';

/* --------------------------------------------------------------------------
   APOIO — arquivos gravados e leitor MIME mínimo
   -------------------------------------------------------------------------- */

const servidores = [];
const arquivosCriados = [];

/**
 * Grava um arquivo em site/assets/enviados/ com o formato que /api/upload
 * usa (UUID.extensão). Devolve o caminho relativo que a rota devolve, para
 * o teste alimentar o disparo como se o admin tivesse subido o anexo antes.
 */
function gravarEnviado(extensao, conteudo) {
  const nome = `${crypto.randomUUID()}.${extensao}`;
  const alvo = path.join(email.PASTA_ENVIADOS, nome);
  fs.mkdirSync(email.PASTA_ENVIADOS, { recursive: true });
  fs.writeFileSync(alvo, conteudo);
  arquivosCriados.push(alvo);
  return { nome, caminho: `assets/enviados/${nome}`, alvo };
}

async function subirFalso(opcoes = {}) {
  const servidor = falso.criar({
    tls: true, usuario: USUARIO, senha: SENHA, ...opcoes
  });
  await servidor.ouvir();
  servidores.push(servidor);
  return servidor;
}

/** Aponta a configuração de SMTP do banco para um servidor local. */
function apontarSmtp({ porta, seguranca = 'SSL' }) {
  db.executar(
    `UPDATE smtp SET servidor_saida = ?, smtp = ?, seguranca = ?, usuario = ?, email = ?
      WHERE id = 1`,
    '127.0.0.1', porta, seguranca, USUARIO, USUARIO
  );
}

/** Certificado do servidor falso é autoassinado — o cliente precisa aceitar. */
function ligarCertificadoAutoassinado(ligar) {
  if (ligar) process.env.PHYGITAL_SMTP_CERT_INVALIDO = '1';
  else delete process.env.PHYGITAL_SMTP_CERT_INVALIDO;
}

/** Separa cabeçalhos e corpo de um MIME. */
function separar(mime) {
  const corte = String(mime).indexOf(CRLF + CRLF);
  const bruto = corte === -1 ? String(mime) : String(mime).slice(0, corte);
  const corpo = corte === -1 ? '' : String(mime).slice(corte + 4);

  const linhas = [];
  for (const linha of bruto.split(CRLF)) {
    if (/^[ \t]/.test(linha) && linhas.length) linhas[linhas.length - 1] += ` ${linha.trim()}`;
    else linhas.push(linha);
  }

  const cabecalhos = {};
  for (const linha of linhas) {
    const divisao = linha.indexOf(':');
    if (divisao === -1) continue;
    cabecalhos[linha.slice(0, divisao).trim().toLowerCase()] = linha.slice(divisao + 1).trim();
  }

  return { cabecalhos, corpo };
}

function partesDe(corpo, fronteira) {
  const partes = [];
  let atual = null;
  for (const linha of corpo.split(CRLF)) {
    if (linha === `--${fronteira}`) { atual = []; partes.push(atual); continue; }
    if (linha === `--${fronteira}--`) { atual = null; continue; }
    if (atual) atual.push(linha);
  }
  return partes.map((l) => l.join(CRLF));
}

function achatar(mime) {
  const { cabecalhos, corpo } = separar(mime);
  const tipo = cabecalhos['content-type'] || 'text/plain';
  const fronteira = (tipo.match(/boundary="([^"]+)"/) || [])[1];
  if (fronteira) return partesDe(corpo, fronteira).flatMap(achatar);

  const codificacao = String(cabecalhos['content-transfer-encoding'] || '').toLowerCase();
  const conteudo = codificacao === 'base64'
    ? Buffer.from(corpo.replace(/\r?\n/g, ''), 'base64')
    : Buffer.from(corpo, 'utf8');

  return [{ tipo: tipo.split(';')[0].trim().toLowerCase(), cabecalhos, conteudo }];
}

const parteDo = (mime, tipo) => achatar(mime).find((p) => p.tipo === tipo);

/* ==========================================================================
   OS TESTES
   ========================================================================== */

describe('anexo de e-mail — encanamento completo', () => {
  const original = {};

  before(async () => {
    original.senha = process.env.PHYGITAL_SMTP_SENHA;
    original.real = process.env.PHYGITAL_EMAIL_REAL;
    original.cert = process.env.PHYGITAL_SMTP_CERT_INVALIDO;
    original.smtp = db.um('SELECT * FROM smtp WHERE id = 1');

    /* Trava herdada de 10-smtp.js: destino é 127.0.0.1 ANTES de liberar
       envio real, e a senha só entra no ambiente depois. */
    apontarSmtp({ porta: 1 });               /* porta impossível, provisória */
    process.env.PHYGITAL_SMTP_SENHA = SENHA;
    process.env.PHYGITAL_EMAIL_REAL = '1';
    ligarCertificadoAutoassinado(true);

    assert.equal(
      db.valor('SELECT servidor_saida FROM smtp WHERE id = 1'), '127.0.0.1',
      'nenhum teste pode apontar para o servidor de e-mail de verdade'
    );
  });

  after(async () => {
    for (const s of servidores) {
      try { await s.parar(); } catch (_) { /* já pode ter caído */ }
    }
    servidores.length = 0;

    for (const alvo of arquivosCriados) {
      try { fs.unlinkSync(alvo); } catch (_) { /* já apagado */ }
    }
    arquivosCriados.length = 0;

    if (original.senha === undefined) delete process.env.PHYGITAL_SMTP_SENHA;
    else process.env.PHYGITAL_SMTP_SENHA = original.senha;

    if (original.real === undefined) delete process.env.PHYGITAL_EMAIL_REAL;
    else process.env.PHYGITAL_EMAIL_REAL = original.real;

    if (original.cert === undefined) delete process.env.PHYGITAL_SMTP_CERT_INVALIDO;
    else process.env.PHYGITAL_SMTP_CERT_INVALIDO = original.cert;

    if (original.smtp) {
      db.executar(
        `UPDATE smtp SET servidor_saida = ?, smtp = ?, seguranca = ?, usuario = ?, email = ?
          WHERE id = 1`,
        original.smtp.servidor_saida, original.smtp.smtp, original.smtp.seguranca,
        original.smtp.usuario, original.smtp.email
      );
    }

    db.executar("DELETE FROM emails_enviados WHERE status IN ('fila', 'entregue', 'falhou')");
  });

  /* ------------------------------------------------------------------------
     ESQUEMA
     ------------------------------------------------------------------------ */

  it('a tabela emails_enviados tem coluna anexos', () => {
    const colunas = db.todos('PRAGMA table_info(emails_enviados)').map((c) => c.name);
    assert.ok(
      colunas.includes('anexos'),
      'sem a coluna anexos o metadado dos arquivos anexos se perde entre gravar e despachar'
    );
  });

  /* ------------------------------------------------------------------------
     ENTREGA COM ANEXO DE VERDADE
     ------------------------------------------------------------------------ */

  it('anexo PDF vai como multipart/mixed e chega inteiro ao SMTP', async () => {
    const servidor = await subirFalso();
    apontarSmtp({ porta: servidor.porta });

    /* Conteúdo binário reprodutível — os 256 valores de byte pegam qualquer
       corrupção no caminho, e o prefixo '%PDF-' passa pelo reconhecedor. */
    const conteudoPdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.from('\n%%EOF\n', 'latin1')
    ]);
    const { caminho } = gravarEnviado('pdf', conteudoPdf);

    const enfileirado = email.enviar({
      para: 'ana@exemplo.com',
      destino: 'Teste com anexo',
      assunto: 'Regulamento em anexo',
      corpo: '<p>Segue o regulamento.</p>',
      anexos: [{
        nome: 'Regulamento — copa 2026.pdf',
        caminho,
        tipo: 'application/pdf',
        tamanho: conteudoPdf.length
      }]
    });

    assert.equal(enfileirado.status, 'fila', 'com senha e envio liberado a linha vai para a fila real');

    /* O metadado tem que ter sido persistido: sem isso o dispatcher entrega
       só o corpo, que era o gargalo antigo. */
    const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', enfileirado.id);
    assert.ok(linha.anexos, 'a coluna anexos precisa guardar os metadados');
    const metadados = JSON.parse(linha.anexos);
    assert.equal(metadados.length, 1);
    assert.equal(metadados[0].caminho, caminho);
    assert.equal(metadados[0].tipo, 'application/pdf');

    await fila.despachar();

    /* Espera a rodada terminar e confere no servidor de mentira. */
    const recebida = servidor.ultima();
    assert.ok(recebida, 'o SMTP falso precisa ter recebido a mensagem');

    const partes = achatar(recebida.dados);
    const anexoRecebido = partes.find((p) => p.tipo === 'application/pdf');
    assert.ok(anexoRecebido, 'o anexo tem que aparecer como parte própria do multipart/mixed');

    /* Os bytes têm que bater com o que estava no disco. */
    assert.equal(
      Buffer.compare(anexoRecebido.conteudo, conteudoPdf), 0,
      'os bytes do anexo têm que atravessar o SMTP sem alteração'
    );

    /* E o corpo continua ali junto, como parte HTML própria. */
    assert.ok(parteDo(recebida.dados, 'text/html'), 'o corpo HTML tem que continuar sendo entregue');

    const linhaFinal = db.um('SELECT * FROM emails_enviados WHERE id = ?', enfileirado.id);
    assert.equal(linhaFinal.status, 'entregue', 'o dispatcher tem que marcar como entregue');
  });

  /* ------------------------------------------------------------------------
     REJEIÇÃO DE CAMINHO INVÁLIDO
     ------------------------------------------------------------------------ */

  it('caminho fora do padrão é descartado pela rota /disparar (nada de travessia)', async () => {
    /* limparAnexos é a função da rota que peneira o payload. */
    const rotas = require(path.join(amb.RAIZ, 'server', 'rotas', 'email'));
    /* A função não é exportada, então exercemos pela rota — o efeito colateral
       que importa é que o metadado gravado NÃO carregue o `caminho` torto. */

    const servidor = await subirFalso();
    apontarSmtp({ porta: servidor.porta });

    const mestre = amb.comoMaster();

    const r = await mestre.post('/api/email/disparar', {
      assunto: 'Sem anexo real',
      corpo: 'Conteúdo qualquer',
      alvo: 'manual',
      destinatarios: ['ana@exemplo.com'],
      anexos: [
        { nome: 'travessia', caminho: '../../etc/passwd', tipo: 'text/plain', tamanho: 12 },
        { nome: 'absoluto', caminho: '/etc/hosts', tipo: 'text/plain', tamanho: 10 },
        { nome: 'sem-uuid', caminho: 'assets/enviados/qualquer.txt', tipo: 'text/plain', tamanho: 1 }
      ]
    });

    assert.equal(r.status, 200, 'a rota não deve derrubar o disparo por um caminho torto');
    const registro = r.corpo.registro;
    assert.ok(registro, 'a linha do disparo tem que voltar na resposta');

    const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', registro.id);
    const metadados = linha.anexos ? JSON.parse(linha.anexos) : [];

    /* Todos os anexos continuam listados (o admin vê que enviou algo), mas
       NENHUM deles carrega `caminho`: os três eram inválidos. Sem caminho, o
       dispatcher entrega o comunicado sem o arquivo. */
    for (const meta of metadados) {
      assert.equal(meta.caminho, undefined, 'caminho torto não pode sobreviver: ' + meta.nome);
    }

    /* Requisito adicional: mesmo com o caminho descartado, o comunicado é
       enviado (não regride para "sem anexo" derruba o disparo). */
    await new Promise((pronto) => setImmediate(pronto));
    assert.ok(servidor.recebidas.length > 0, 'o comunicado sem os arquivos deve sair mesmo assim');
    /* garantia de uso da referência */
    assert.ok(rotas.registrar);
  });

  /* ------------------------------------------------------------------------
     ARQUIVO SUMIDO DO DISCO
     ------------------------------------------------------------------------ */

  it('arquivo sumido vira falha limpa, sem exceção', async () => {
    const servidor = await subirFalso();
    apontarSmtp({ porta: servidor.porta });

    /* Grava e apaga: o metadado aponta para um caminho que existia e sumiu — é
       o cenário da faxina de órfãos rodando entre gravar e despachar. */
    const conteudo = Buffer.from('%PDF-1.7\n' + 'X'.repeat(64) + '\n%%EOF\n', 'latin1');
    const { caminho, alvo } = gravarEnviado('pdf', conteudo);
    fs.unlinkSync(alvo);
    /* Já não precisa mais faxinar no fim. */
    const i = arquivosCriados.indexOf(alvo);
    if (i >= 0) arquivosCriados.splice(i, 1);

    const enfileirado = email.enviar({
      para: 'ana@exemplo.com',
      destino: 'Anexo sumido',
      assunto: 'Anexo sumido',
      corpo: '<p>Corpo</p>',
      anexos: [{
        nome: 'sumido.pdf', caminho, tipo: 'application/pdf', tamanho: conteudo.length
      }]
    });

    assert.equal(enfileirado.status, 'fila');

    /* despachar() não lança. */
    await fila.despachar();

    const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', enfileirado.id);
    assert.equal(linha.status, 'falhou',
      'anexo apontando para arquivo inexistente é falha de envio, não da rodada inteira');
    assert.ok(String(linha.erro || '').toLowerCase().includes('anexo'),
      'o motivo tem que dizer que o anexo é a causa');
    /* Nada foi transmitido — não vale mandar o comunicado sem o arquivo
       prometido no texto. */
    assert.equal(servidor.recebidas.length, 0);
  });

  /* ------------------------------------------------------------------------
     ENVIO SEM ANEXO (REGRESSÃO)
     ------------------------------------------------------------------------ */

  it('envio sem anexo continua entregando só o corpo, sem parte extra', async () => {
    const servidor = await subirFalso();
    apontarSmtp({ porta: servidor.porta });

    const enfileirado = email.enviar({
      para: 'ana@exemplo.com',
      destino: 'Sem anexo',
      assunto: 'Sem anexo',
      corpo: '<p>Só o texto.</p>'
    });

    assert.equal(enfileirado.status, 'fila');

    const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', enfileirado.id);
    assert.equal(linha.anexos, null, 'sem anexos a coluna fica NULL — nada de JSON vazio no banco');

    await fila.despachar();

    const recebida = servidor.ultima();
    assert.ok(recebida);

    /* Nenhuma parte com tipo diferente de text/*: a mensagem é só corpo. */
    const partes = achatar(recebida.dados);
    const naoTexto = partes.filter((p) => !p.tipo.startsWith('text/'));
    assert.equal(naoTexto.length, 0, 'sem anexo não pode aparecer parte binária no multipart');

    const linhaFinal = db.um('SELECT * FROM emails_enviados WHERE id = ?', enfileirado.id);
    assert.equal(linhaFinal.status, 'entregue');
  });
});
