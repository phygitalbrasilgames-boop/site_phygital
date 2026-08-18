/* ==========================================================================
   SMTP — o cliente de envio, a mensagem que ele monta e a fila de saída

   Nada aqui sai da máquina: todo envio vai para o servidor SMTP falso de
   testes/apoio/smtp-falso.js, que fala o protocolo de verdade em 127.0.0.1 e
   guarda a mensagem crua para conferência. Nenhum teste depende de rede, de
   DNS ou do provedor — e nenhum e-mail chega a pessoa nenhuma.

   O que este arquivo protege, em ordem de importância:

   · a senha do SMTP não vaza. Ela vive só em PHYGITAL_SMTP_SENHA e não pode
     aparecer em log, em diálogo de diagnóstico, em mensagem de erro nem no
     banco;
   · a senha não viaja em claro: sem TLS implícito e sem STARTTLS, o envio
     falha em vez de autenticar em texto puro;
   · a mensagem chega inteira. Acento no assunto, acento no corpo, anexo
     binário, e a linha com um ponto sozinho que o dot-stuffing precisa
     atravessar;
   · o que vem de fora não vira cabeçalho novo (injeção de cabeçalho);
   · falha temporária (4xx, queda de conexão) volta para a fila; falha
     permanente (5xx) não volta.

   Este arquivo roda por último porque precisa ligar o envio real para poder
   testá-lo: ele aponta a tabela smtp para 127.0.0.1 e só DEPOIS põe uma senha
   de mentira em PHYGITAL_SMTP_SENHA. A ordem importa — é a senha que faz
   email.enviar() parar de simular, e quando ela chega o destino já é a porta
   fechada da própria máquina. As duas coisas voltam ao que eram no fim, e
   nenhum outro caso deve depender delas.
   ========================================================================== */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');

const amb = require('../apoio/ambiente');
const falso = require('../apoio/smtp-falso');

const smtp = require(path.join(amb.RAIZ, 'server', 'smtp'));
const email = require(path.join(amb.RAIZ, 'server', 'email'));

const db = amb.db;

const CRLF = '\r\n';

/* Credencial de mentira, do tamanho de uma de verdade. Só existe em memória e
   é justamente o que os testes de vazamento procuram na saída. */
const USUARIO = 'inscricoes@phygitalgamesbr.com.br';
const SENHA = 'Tr1color-Fita-2026-secreta';
const SENHA_B64 = Buffer.from(SENHA, 'utf8').toString('base64');
const REMETENTE = 'inscricoes@phygitalgamesbr.com.br';

/* ==========================================================================
   APOIO
   ========================================================================== */

const servidores = [];

/**
 * Sobe um servidor falso e devolve, junto, a configuração de cliente que fala
 * com ele. `config(extra)` já resolve porta, TLS e credencial a partir das
 * opções do servidor — é o que impede um teste apontar para a porta certa com
 * a segurança errada.
 */
async function subirFalso(opcoes = {}) {
  const servidor = falso.criar(opcoes);
  await servidor.ouvir();
  servidores.push(servidor);

  const config = (extra = {}) => ({
    host: '127.0.0.1',
    porta: servidor.porta,
    /* Porta efêmera nunca é 465, então a segurança vai dita, não deduzida. */
    seguro: Boolean(opcoes.tls),
    usuario: opcoes.usuario ? USUARIO : '',
    senha: opcoes.usuario ? SENHA : '',
    remetente: REMETENTE,
    nomeRemetente: 'Esportes Phygital Brasil',
    /* O certificado do servidor de teste é autoassinado e nasce na hora; sem
       este escape o handshake pararia antes do banner. Em produção ele fica
       desligado — é o que impede entregar a senha a quem atender a conexão. */
    permitirCertificadoInvalido: true,
    /* Nome fixo no EHLO: sem isso o diálogo carregaria o hostname da máquina
       de quem rodou a suíte. */
    nomeLocal: 'testes.phygital.local',
    timeoutMs: 5000,
    ...extra
  });

  return { servidor, config };
}

/** Uma porta que ninguém está ouvindo: sobe e derruba um servidor de mentira. */
async function portaFechada() {
  const servidor = falso.criar({});
  const porta = await servidor.ouvir();
  await servidor.parar();
  return porta;
}

/** Roda `fn` com o console sequestrado, para inspecionar o que ele imprimiu. */
async function capturarConsole(fn) {
  const linhas = [];
  const metodos = ['log', 'info', 'warn', 'error', 'debug'];
  const originais = {};

  for (const m of metodos) {
    originais[m] = console[m];
    console[m] = (...args) => linhas.push(
      args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' ')
    );
  }

  try {
    const resultado = await fn();
    return { resultado, erro: null, linhas };
  } catch (erro) {
    return { resultado: null, erro, linhas };
  } finally {
    for (const m of metodos) console[m] = originais[m];
  }
}

/** Executa e devolve o erro em vez de propagá-lo. */
const pegarErro = (promessa) => promessa.then(() => null, (e) => e);

/* --------------------------------------------------------------------------
   LEITOR DE MIME

   Um decodificador de mentira, do mesmo espírito do servidor de mentira: só o
   suficiente para conferir o que o cliente montou. Ele não compartilha código
   com server/smtp.js de propósito — teste que reusa a implementação que está
   testando só prova que ela é consistente consigo mesma.
   -------------------------------------------------------------------------- */

/**
 * Separa cabeçalhos e corpo. Os cabeçalhos vêm DESDOBRADOS: linha que começa
 * com espaço ou tabulação é continuação da anterior (RFC 5322 §2.2.3), e não
 * cabeçalho novo. É exatamente essa diferença que o teste de injeção mede.
 */
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

  return { cabecalhos, nomes: linhas.map((l) => l.split(':')[0].toLowerCase()), corpo };
}

/** Desfaz os encoded-words do RFC 2047 e devolve o texto original. */
function decodificar2047(valor) {
  return String(valor === undefined || valor === null ? '' : valor)
    /* Espaço entre duas palavras codificadas é separador de transporte, não
       texto: o RFC 2047 manda descartá-lo antes de emendar os pedaços. */
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, tipo, dado) => (
      tipo.toUpperCase() === 'B'
        ? Buffer.from(dado, 'base64').toString('utf8')
        : decodificarQP(dado.replace(/_/g, ' ')).toString('utf8')
    ));
}

/** Quoted-printable de volta a bytes (RFC 2045). */
function decodificarQP(texto) {
  const semQuebraMole = String(texto).replace(/=\r?\n/g, '');
  const bytes = [];

  for (let i = 0; i < semQuebraMole.length; i += 1) {
    const par = semQuebraMole.slice(i + 1, i + 3);
    if (semQuebraMole[i] === '=' && /^[0-9A-F]{2}$/i.test(par)) {
      bytes.push(parseInt(par, 16));
      i += 2;
    } else {
      bytes.push(semQuebraMole.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

function decodificarCorpo(corpo, codificacao) {
  const como = String(codificacao || '').toLowerCase();
  if (como === 'base64') return Buffer.from(corpo.replace(/\r?\n/g, ''), 'base64');
  if (como === 'quoted-printable') return decodificarQP(corpo);
  return Buffer.from(corpo, 'utf8');
}

/** Quebra um corpo multipart nas suas partes, pela fronteira declarada. */
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

/** Achata a mensagem numa lista plana de partes, entrando nas multiparts. */
function achatar(mime) {
  const { cabecalhos, corpo } = separar(mime);
  const tipo = cabecalhos['content-type'] || 'text/plain';
  const fronteira = (tipo.match(/boundary="([^"]+)"/) || [])[1];

  if (fronteira) return partesDe(corpo, fronteira).flatMap(achatar);

  return [{
    tipo: tipo.split(';')[0].trim().toLowerCase(),
    cabecalhos,
    conteudo: decodificarCorpo(corpo, cabecalhos['content-transfer-encoding'])
  }];
}

const parteDo = (mime, tipo) => achatar(mime).find((p) => p.tipo === tipo);

/** Nome do anexo na forma estendida do RFC 2231, que é a que preserva acento. */
function nomeEstendido(valor) {
  const achado = String(valor || '').match(/filename\*=UTF-8''([^;\s]+)/i);
  return achado ? decodeURIComponent(achado[1]) : null;
}

/* ==========================================================================
   OS TESTES
   ========================================================================== */

describe('smtp', () => {
  const original = {};

  before(async () => {
    original.senha = process.env.PHYGITAL_SMTP_SENHA;
    original.real = process.env.PHYGITAL_EMAIL_REAL;
    original.smtp = db.um('SELECT * FROM smtp WHERE id = 1');

    /* TRAVA DE SEGURANÇA DESTE ARQUIVO.

       Daqui para baixo existe senha de SMTP no ambiente, e com senha o
       email.enviar() para de simular: ele grava a linha como 'fila' e agenda um
       despacho de verdade. A configuração do banco é apontada ANTES disso para
       uma porta fechada em 127.0.0.1 — assim nem uma senha real herdada do
       ambiente de quem rodou a suíte alcança o provedor a partir daqui. */
    apontarSmtp({ servidor: '127.0.0.1', porta: await portaFechada() });
    process.env.PHYGITAL_SMTP_SENHA = SENHA;
    /* Só a senha não liga mais o envio: é preciso liberar de propósito. A trava
       existe porque a semente grava o servidor de PRODUÇÃO, e sem ela bastaria
       exportar a senha para um teste de inscrição mandar e-mail a pessoas
       reais. Aqui a liberação é segura — o destino é uma porta fechada em
       127.0.0.1, garantido pela asserção abaixo. */
    process.env.PHYGITAL_EMAIL_REAL = '1';

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

    /* A senha e a configuração voltam ao que eram: esquecer qualquer uma das
       duas aqui faria o próximo envio do processo tentar sair de verdade. */
    if (original.senha === undefined) delete process.env.PHYGITAL_SMTP_SENHA;
    else process.env.PHYGITAL_SMTP_SENHA = original.senha;

    if (original.real === undefined) delete process.env.PHYGITAL_EMAIL_REAL;
    else process.env.PHYGITAL_EMAIL_REAL = original.real;

    if (original.smtp) {
      db.executar(
        `UPDATE smtp SET servidor_saida = ?, smtp = ?, seguranca = ?, usuario = ?, email = ?
          WHERE id = 1`,
        original.smtp.servidor_saida, original.smtp.smtp, original.smtp.seguranca,
        original.smtp.usuario, original.smtp.email
      );
    }

    /* A fila deste arquivo é fixture, não histórico: sai junto. */
    db.executar("DELETE FROM emails_enviados WHERE status = 'fila'");
  });

  /* ------------------------------------------------------------------------
     HANDSHAKE E AUTENTICAÇÃO
     ------------------------------------------------------------------------ */

  it('o percurso completo em TLS implícito entrega a mensagem e usa AUTH PLAIN', async () => {
    const { servidor, config } = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA, mecanismos: 'PLAIN LOGIN'
    });

    const r = await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com',
      assunto: 'Handshake completo',
      html: '<p>Tudo certo.</p>'
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.aceitos, ['ana@exemplo.com']);
    assert.deepEqual(r.recusados, []);
    assert.match(r.idMensagem, /^<.+@phygitalgamesbr\.com\.br>$/);

    const recebida = servidor.ultima();
    assert.ok(recebida, 'o servidor falso precisa ter recebido a mensagem');
    assert.equal(recebida.cifrado, true, 'porta 465 nasce cifrada: nada pode trafegar em claro');
    assert.equal(recebida.de, REMETENTE, 'o MAIL FROM é a conta autenticada');
    assert.deepEqual(recebida.para, ['ana@exemplo.com']);

    /* Ordem do protocolo: cumprimentar, autenticar, só então transacionar. */
    const verbos = recebida.comandos.map((c) => c.split(/[\s:]/)[0].toUpperCase());
    assert.equal(verbos[0], 'EHLO');
    assert.ok(verbos.indexOf('AUTH') < verbos.indexOf('MAIL'));
    assert.ok(verbos.indexOf('MAIL') < verbos.indexOf('RCPT'));
    assert.ok(verbos.indexOf('RCPT') < verbos.indexOf('DATA'));
    assert.ok(!verbos.includes('STARTTLS'), 'com TLS implícito não existe STARTTLS');

    /* RFC 4616: a credencial do PLAIN é <NUL>usuário<NUL>senha em base64.
       Decodificar aqui é o que prova que o cliente montou o formato certo —
       e é seguro: este é o log em memória do servidor de mentira. */
    const linhaAuth = recebida.comandos.find((c) => c.startsWith('AUTH PLAIN '));
    assert.ok(linhaAuth, 'o cliente precisa ter usado AUTH PLAIN');
    assert.equal(
      Buffer.from(linhaAuth.slice('AUTH PLAIN '.length), 'base64').toString('utf8'),
      `\0${USUARIO}\0${SENHA}`
    );
  });

  it('em STARTTLS a conexão abre em claro, cifra, repete o EHLO e só então autentica', async () => {
    const { servidor, config } = await subirFalso({
      starttls: true, usuario: USUARIO, senha: SENHA, mecanismos: 'LOGIN'
    });

    const r = await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com',
      assunto: 'Porta 587',
      texto: 'Mensagem por STARTTLS.'
    });

    assert.equal(r.ok, true);

    const recebida = servidor.ultima();
    assert.equal(recebida.cifrado, true, 'a mensagem só pode chegar depois do TLS');

    const posicao = (prefixo) => recebida.comandos.findIndex((c) => c.toUpperCase().startsWith(prefixo));
    assert.ok(posicao('STARTTLS') > -1, 'o cliente precisa pedir STARTTLS');
    assert.ok(posicao('AUTH') > posicao('STARTTLS'), 'a credencial só sai depois de cifrar');

    /* RFC 3207 §4.2: o EHLO é obrigatório outra vez depois do STARTTLS, porque
       o que o servidor anunciou antes não vale mais. */
    assert.equal(recebida.comandos.filter((c) => c.toUpperCase().startsWith('EHLO')).length, 2);

    /* AUTH LOGIN é conversado: usuário e senha vão em passos separados. */
    const inicio = posicao('AUTH LOGIN');
    assert.equal(Buffer.from(recebida.comandos[inicio + 1], 'base64').toString('utf8'), USUARIO);
    assert.equal(Buffer.from(recebida.comandos[inicio + 2], 'base64').toString('utf8'), SENHA);
  });

  it('servidor sem STARTTLS não recebe nada: a senha não viaja em texto puro', async () => {
    const { servidor, config } = await subirFalso({
      starttls: false, usuario: USUARIO, senha: SENHA
    });

    const erro = await pegarErro(smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com', assunto: 'Não deve sair', texto: 'nada'
    }));

    assert.ok(erro, 'enviar em claro tem que falhar');
    assert.match(erro.message, /STARTTLS/);
    assert.equal(erro.permanente, true, 'servidor sem TLS não melhora com nova tentativa');
    assert.equal(servidor.recebidas.length, 0);
    assert.ok(
      !servidor.comandos.some((c) => c.toUpperCase().startsWith('AUTH')),
      'nem o AUTH pode ter sido tentado'
    );
  });

  /* ------------------------------------------------------------------------
     A MENSAGEM
     ------------------------------------------------------------------------ */

  it('o assunto com acento viaja em RFC 2047 e volta ao original', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    const assunto = 'Inscrição confirmada — Copa Phygital Futebol 2026 · protocolo 2026-000091';

    await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com', assunto, html: '<p>ok</p>'
    });

    const cru = servidor.ultima().dados;

    /* Nenhum byte acima de 127 pode aparecer no cabeçalho: servidor sem
       8BITMIME rebaixaria a mensagem e o acento chegaria corrompido. */
    const cabecalhoCru = cru.slice(0, cru.indexOf(CRLF + CRLF));
    assert.ok(/=\?UTF-8\?B\?/.test(cabecalhoCru), 'o assunto acentuado precisa ir codificado');
    assert.ok(
      cabecalhoCru.split('').every((c) => c.charCodeAt(0) < 128),
      'cabeçalho tem que ser ASCII puro'
    );

    /* Nenhuma linha do cabeçalho passa das 78 colunas do RFC 5322. */
    for (const linha of cabecalhoCru.split(CRLF)) {
      assert.ok(linha.length <= 78, `linha de cabeçalho comprida demais: ${linha}`);
    }

    assert.equal(decodificar2047(separar(cru).cabecalhos.subject), assunto);
  });

  it('o corpo com acento chega inteiro em texto puro e em HTML', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    const texto = 'Olá, Tigres Phygital! Ação, emoção e inscrição confirmada — até lá.';
    const html = '<h1>Inscrição confirmada</h1><p>Olá, <b>Tigres Phygital</b>! Ação e emoção.</p>';

    await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com', assunto: 'Corpo acentuado', texto, html
    });

    const partes = achatar(servidor.ultima().dados);
    const plano = partes.find((p) => p.tipo === 'text/plain');
    const rico = partes.find((p) => p.tipo === 'text/html');

    assert.ok(plano && rico, 'sem versão em texto o filtro de spam desconfia da mensagem só-HTML');
    assert.equal(plano.cabecalhos['content-transfer-encoding'], 'quoted-printable');
    assert.equal(rico.cabecalhos['content-transfer-encoding'], 'base64');
    assert.equal(plano.conteudo.toString('utf8'), texto);
    assert.equal(rico.conteudo.toString('utf8'), html);

    /* O HTML vem DEPOIS do texto: o cliente exibe a última parte que entende. */
    assert.ok(partes.indexOf(plano) < partes.indexOf(rico));
  });

  it('o HTML do modelo da marca atravessa o SMTP sem perder um byte', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    /* O envelope de verdade, montado por server/email.js: 3 KB de tabela, com
       acento, aspas e o "&" da entidade. É o que sai para o competidor. */
    const html = email.montarHtml({
      assunto: 'Inscrição confirmada — Copa Phygital Futebol 2026',
      corpo: '<p>Olá, <b>Tigres Phygital</b>! Sua inscrição foi recebida.</p>'
        + '<p>Protocolo 2026-000091. Atenção: confirma o recebimento e não garante vaga.</p>',
      anexos: [{ nome: 'Regulamento — futebol.pdf', tamanho: 120000 }]
    });

    await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com', assunto: 'Modelo da marca', html
    });

    assert.equal(parteDo(servidor.ultima().dados, 'text/html').conteudo.toString('utf8'), html);
  });

  it('o anexo chega com o nome acentuado certo e os bytes intactos', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    /* Conteúdo binário de propósito, com os 256 valores de byte: é o que pega
       um base64 que trate o anexo como texto pelo caminho. */
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const nome = 'Relatório — inscrições (2026).csv';

    await smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com',
      assunto: 'Com anexo',
      html: '<p>Segue o relatório.</p>',
      anexos: [{ nome, tipo: 'text/csv', conteudo: bytes }]
    });

    const anexo = parteDo(servidor.ultima().dados, 'text/csv');
    assert.ok(anexo, 'o anexo tem que chegar como parte própria');
    assert.equal(anexo.cabecalhos['content-transfer-encoding'], 'base64');
    assert.match(anexo.cabecalhos['content-disposition'], /^attachment;/);

    /* O nome com acento vai na forma estendida do RFC 2231; a forma antiga
       entre aspas fica como reserva para cliente velho. */
    assert.equal(nomeEstendido(anexo.cabecalhos['content-disposition']), nome);
    assert.match(anexo.cabecalhos['content-disposition'], /filename="Relatorio _ inscricoes \(2026\)\.csv"/);

    assert.equal(Buffer.compare(anexo.conteudo, bytes), 0, 'os bytes do anexo têm que bater');

    const linhas = servidor.ultima().dados.split(CRLF);

    /* Base64 em no máximo 76 colunas, como o RFC 2045 exige. */
    const base64 = linhas.filter((l) => /^[A-Za-z0-9+/]{16,}={0,2}$/.test(l));
    assert.ok(base64.length > 3, 'o anexo binário precisa render várias linhas de base64');
    assert.ok(base64.every((l) => l.length <= 76));

    /* O parâmetro de nome do RFC 2231 é um token só e passa das 78 colunas de
       propósito — parti-lo ao meio produziria cabeçalho inválido. O que não
       pode é passar do limite duro de 998 do RFC 5322. */
    assert.ok(linhas.every((l) => l.length <= 998));
  });

  it('a linha com um ponto sozinho atravessa o DATA por dot-stuffing', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    /* Sem anexo e sem HTML a mensagem não tem fronteira aleatória, e com data e
       Message-ID fixos ela fica byte a byte reprodutível — é o que permite
       comparar o que saiu com o que chegou, sem margem. */
    const mensagem = {
      de: { nome: 'Esportes Phygital Brasil', endereco: REMETENTE },
      para: 'ana@exemplo.com',
      assunto: 'Regulamento em um ponto',
      texto: [
        'Confira o regulamento.',
        '.',
        'A linha acima tem um ponto sozinho, que encerraria o DATA.',
        '..dois pontos também.'
      ].join('\n'),
      data: new Date('2026-02-10T13:45:00Z'),
      idMensagem: '<ponto-sozinho@phygitalgamesbr.com.br>'
    };

    const r = await smtp.enviarMensagem(config(), mensagem);
    assert.equal(r.ok, true);

    const recebida = servidor.ultima();
    const linhasCruas = recebida.dadosCrus.split(CRLF);

    /* No fio todo ponto de começo de linha vai dobrado (RFC 5321 §4.5.2)... */
    assert.ok(linhasCruas.includes('..'), 'o ponto sozinho tem que sair dobrado');
    assert.ok(
      linhasCruas.some((l) => l.startsWith('...dois pontos')),
      'a linha que já começava com dois pontos ganha o terceiro'
    );
    /* ...e do outro lado volta ao que era, com a mensagem inteira preservada. */
    assert.equal(recebida.dados, smtp.montarMime(mensagem));

    const plano = parteDo(recebida.dados, 'text/plain');
    assert.equal(plano.conteudo.toString('utf8'), mensagem.texto.replace(/\n/g, CRLF));
  });

  it('quebra de linha no assunto não cria cabeçalho novo', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    await smtp.enviarMensagem(config(), {
      de: { nome: 'Phygital\r\nX-Falso: sim', endereco: REMETENTE },
      para: 'vitima@exemplo.com',
      assunto: 'Alerta\r\nBcc: espiao@exemplo.com',
      texto: 'corpo comum'
    });

    const recebida = servidor.ultima();
    const { cabecalhos, nomes } = separar(recebida.dados);

    assert.equal(cabecalhos.bcc, undefined, 'o assunto não pode ter criado um Bcc');
    assert.equal(cabecalhos['x-falso'], undefined, 'nem o nome de exibição pode criar cabeçalho');
    assert.ok(!nomes.includes('bcc'));

    /* A quebra virou espaço: o texto continua visível, mas como assunto. */
    assert.equal(cabecalhos.subject, 'Alerta Bcc: espiao@exemplo.com');

    /* E o envelope: quem recebeu foi só a vítima declarada. */
    assert.deepEqual(recebida.para, ['vitima@exemplo.com']);
    assert.equal(recebida.comandos.filter((c) => c.toUpperCase().startsWith('RCPT')).length, 1);
  });

  it('quebra de linha no destinatário não vira um RCPT TO extra', async () => {
    const { servidor, config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    await smtp.enviarMensagem(config(), {
      para: 'vitima@exemplo.com>\r\nRCPT TO:<espiao@exemplo.com',
      assunto: 'Envelope',
      texto: 'corpo comum'
    });

    const rcpts = servidor.comandos.filter((c) => c.toUpperCase().startsWith('RCPT'));
    assert.equal(rcpts.length, 1, 'um endereço pedido, um RCPT TO enviado');
    assert.ok(
      !servidor.comandos.some((c) => c.includes('<espiao@exemplo.com>')),
      'o espião não pode ter virado destinatário'
    );
    assert.equal(servidor.ultima().para.length, 1);
  });

  /* ------------------------------------------------------------------------
     O SEGREDO

     A senha vem de PHYGITAL_SMTP_SENHA, não é gravada e não é registrada. Os
     testes abaixo procuram tanto a senha em claro quanto a forma como ela
     trafega (base64), porque um log que imprimisse a linha do AUTH vazaria a
     credencial mesmo sem mostrar texto legível.
     ------------------------------------------------------------------------ */

  it('a senha não aparece no erro, no diálogo nem no console quando o AUTH é recusado', async () => {
    const { servidor, config } = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA, recusarAuth: true
    });

    const { erro, linhas } = await capturarConsole(() => smtp.enviarMensagem(config(), {
      para: 'ana@exemplo.com', assunto: 'Não vai sair', texto: 'nada'
    }));

    assert.ok(erro, 'AUTH recusado tem que falhar o envio');
    assert.equal(erro.codigo, 535);
    assert.equal(erro.permanente, true, '5xx no AUTH é senha errada: repetir só soma bloqueio');
    assert.equal(servidor.recebidas.length, 0);

    const suspeitos = [erro.message, (erro.dialogo || []).join('\n'), linhas.join('\n')].join('\n');
    assert.ok(!suspeitos.includes(SENHA), 'a senha em claro não pode aparecer');
    assert.ok(!suspeitos.includes(SENHA_B64), 'nem a senha em base64');
    assert.equal(linhas.length, 0, 'o cliente SMTP não deve imprimir nada por conta própria');

    /* O diálogo guardado para diagnóstico mostra o passo, com a credencial já
       trocada por asteriscos ANTES de ser escrita em qualquer lugar. */
    const dialogo = (erro.dialogo || []).join('\n');
    assert.match(dialogo, /> AUTH PLAIN \*+/);
    assert.match(dialogo, /< 535/);
  });

  it('a senha não aparece no diagnóstico do botão de testar configuração', async () => {
    const { config } = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA, recusarAuth: true
    });

    const { resultado, linhas } = await capturarConsole(() => smtp.verificarConexao(config()));

    assert.equal(resultado.ok, false);
    assert.equal(resultado.autenticado, false);
    assert.equal(resultado.cifrado, true);
    assert.equal(resultado.codigo, 535);

    const tudo = JSON.stringify(resultado) + linhas.join('\n');
    assert.ok(!tudo.includes(SENHA));
    assert.ok(!tudo.includes(SENHA_B64));
  });

  it('a senha do SMTP não tem coluna no banco e não entra no histórico de envio', () => {
    const colunas = db.todos('PRAGMA table_info(smtp)').map((c) => c.name);
    assert.ok(
      !colunas.some((c) => /senha|password|secret/i.test(c)),
      'a tabela smtp não pode ganhar coluna de senha'
    );

    /* Com servidor configurado e senha no ambiente, enviar() grava 'fila' e
       volta na hora — é síncrona e roda dentro de transações de negócio. Quem
       transmite é o despachante, do lado de fora. */
    const enviado = email.enviar({
      para: 'ana@exemplo.com',
      destino: 'Teste de fila',
      assunto: 'Mensagem que espera o despachante',
      corpo: '<p>Conteúdo de teste.</p>'
    });

    assert.equal(enviado.status, 'fila');

    /* Leitura no mesmo tique do INSERT: o despacho agendado por enviar() só
       começa no próximo, então a linha ainda está como nasceu. */
    const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', enviado.id);
    assert.equal(linha.status, 'fila');
    assert.ok(!JSON.stringify(linha).includes(SENHA), 'a senha não pode ir para o banco');
    assert.ok(!JSON.stringify(db.todos('SELECT * FROM smtp')).includes(SENHA));
  });

  /* ------------------------------------------------------------------------
     RECUSA E FALHA
     ------------------------------------------------------------------------ */

  it('um destinatário recusado não impede a entrega dos outros', async () => {
    const { servidor, config } = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA,
      recusar: { 'nao-existe@exemplo.com': '550 5.1.1 destinatário desconhecido' }
    });

    const r = await smtp.enviarMensagem(config(), {
      para: ['ana@exemplo.com', 'nao-existe@exemplo.com', 'bruno@exemplo.com'],
      assunto: 'Convocação da etapa',
      html: '<p>Detalhes no anexo.</p>'
    });

    /* Endereço errado de um time não é falha de infraestrutura: a mensagem sai
       para quem existe e o recusado é reportado. */
    assert.equal(r.ok, true);
    assert.deepEqual(r.aceitos, ['ana@exemplo.com', 'bruno@exemplo.com']);
    assert.equal(r.recusados.length, 1);
    assert.equal(r.recusados[0].endereco, 'nao-existe@exemplo.com');
    assert.equal(r.recusados[0].codigo, 550);
    assert.equal(r.recusados[0].temporario, false);

    const recebida = servidor.ultima();
    assert.deepEqual(recebida.para, ['ana@exemplo.com', 'bruno@exemplo.com']);
    /* O cabeçalho To continua listando os três: o servidor recusou a entrega,
       não a intenção. */
    assert.match(separar(recebida.dados).cabecalhos.to, /nao-existe@exemplo\.com/);
  });

  it('com todos os destinatários recusados nada é transmitido', async () => {
    const { servidor, config } = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA,
      respostas: { RCPT: '451 4.2.1 caixa ocupada, tente depois' }
    });

    const r = await smtp.enviarMensagem(config(), {
      para: ['ana@exemplo.com', 'bruno@exemplo.com'],
      assunto: 'Ninguém aceito',
      texto: 'corpo'
    });

    assert.equal(r.ok, false, 'sem destinatário aceito não há entrega');
    assert.equal(r.codigo, 451);
    assert.equal(r.temporario, true, '4xx em todos: o despachante tenta de novo');
    assert.equal(r.recusados.length, 2);
    assert.equal(servidor.recebidas.length, 0, 'o DATA não podia ter sido enviado');

    /* A transação é limpa antes de sair, para o QUIT partir de um estado
       válido. */
    assert.ok(servidor.comandos.some((c) => c.toUpperCase().startsWith('RSET')));
  });

  it('4xx é falha temporária e 5xx é falha permanente', async () => {
    const temporario = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA,
      respostas: { MAIL: '451 4.3.2 serviço indisponível no momento' }
    });

    const erroTemporario = await pegarErro(smtp.enviarMensagem(temporario.config(), {
      para: 'ana@exemplo.com', assunto: 'x', texto: 'y'
    }));

    assert.equal(erroTemporario.codigo, 451);
    assert.equal(erroTemporario.temporario, true);
    assert.equal(erroTemporario.permanente, false);
    assert.equal(temporario.servidor.recebidas.length, 0);

    const permanente = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA,
      respostas: { MAIL: '550 5.7.1 remetente não autorizado' }
    });

    const erroPermanente = await pegarErro(smtp.enviarMensagem(permanente.config(), {
      para: 'ana@exemplo.com', assunto: 'x', texto: 'y'
    }));

    assert.equal(erroPermanente.codigo, 550);
    assert.equal(erroPermanente.temporario, false);
    assert.equal(erroPermanente.permanente, true);

    /* Um 4xx depois do corpo (o servidor aceita o DATA e reprova no ponto
       final) também é temporário: a mensagem inteira precisa ser reenviada. */
    const noFim = await subirFalso({
      tls: true, usuario: USUARIO, senha: SENHA,
      respostas: { FIM: '451 4.3.0 fila do servidor cheia' }
    });

    const erroNoFim = await pegarErro(smtp.enviarMensagem(noFim.config(), {
      para: 'ana@exemplo.com', assunto: 'x', texto: 'y'
    }));

    assert.equal(erroNoFim.codigo, 451);
    assert.equal(erroNoFim.temporario, true);
  });

  it('conexão recusada é falha temporária, sem deixar promessa pendurada', async () => {
    const porta = await portaFechada();

    const erro = await pegarErro(smtp.enviarMensagem({
      host: '127.0.0.1', porta, seguro: true, usuario: '', senha: '',
      remetente: REMETENTE, permitirCertificadoInvalido: true, timeoutMs: 3000
    }, { para: 'ana@exemplo.com', assunto: 'x', texto: 'y' }));

    assert.ok(erro, 'porta fechada tem que falhar');
    assert.equal(erro.temporario, true, 'servidor fora do ar volta a subir');
    assert.ok(!erro.message.includes(SENHA));
  });

  it('o silêncio do servidor estoura o timeout e a promessa se resolve mesmo assim', async () => {
    /* O servidor segura o banner por 5s; o cliente espera 1s (o piso de
       normalizarConfig). Sem o temporizador de etapa, a promessa nunca
       voltaria — e o e-mail ficaria travado numa transação. */
    const { config } = await subirFalso({ tls: true, atrasos: { BANNER: 5000 } });

    const inicio = Date.now();
    const erro = await pegarErro(smtp.enviarMensagem(config({ timeoutMs: 1000 }), {
      para: 'ana@exemplo.com', assunto: 'x', texto: 'y'
    }));
    const decorrido = Date.now() - inicio;

    assert.ok(erro, 'servidor mudo tem que virar erro');
    assert.match(erro.message, /não respondeu/i);
    assert.equal(erro.temporario, true);
    assert.ok(decorrido < 4000, `desistiu em ${decorrido}ms: não pode esperar o servidor mudo`);
  });

  it('verificarConexao devolve diagnóstico em vez de lançar', async () => {
    const { config } = await subirFalso({ tls: true, usuario: USUARIO, senha: SENHA });

    const bom = await smtp.verificarConexao(config());
    assert.equal(bom.ok, true);
    assert.equal(bom.cifrado, true);
    assert.equal(bom.autenticado, true);
    assert.equal(bom.erro, null);
    assert.match(bom.banner, /^220 /);
    assert.ok(bom.extensoes.some((e) => e.startsWith('AUTH ')));
    assert.ok(bom.dialogo.length > 0);

    /* Nem porta fechada, nem configuração vazia: em nenhum dos dois ela pode
       lançar — quem chama é o botão "testar" do painel. */
    const morto = await smtp.verificarConexao({
      host: '127.0.0.1', porta: await portaFechada(), seguro: true,
      usuario: USUARIO, senha: SENHA, timeoutMs: 2000
    });
    assert.equal(morto.ok, false);
    assert.equal(morto.temporario, true);
    assert.ok(morto.erro && !morto.erro.includes(SENHA));

    const semServidor = await smtp.verificarConexao({ host: '', porta: 465 });
    assert.equal(semServidor.ok, false);
    assert.match(semServidor.erro, /Servidor de saída/i);
  });

  /* ------------------------------------------------------------------------
     A FILA DE SAÍDA

     enviar() é síncrona e roda dentro de transações de negócio: ela só GRAVA a
     linha com status 'fila'. Quem transmite é o despachante, que roda fora da
     transação — uma falha de SMTP não pode desfazer a inscrição de um time.

     Nenhuma destas verificações abre conexão com servidor de e-mail nenhum: a
     falha temporária é uma porta fechada e a permanente é um servidor que não
     oferece STARTTLS.

     O despachante é procurado pelo que ele FAZ (um módulo de server/ que
     exporta despachar()), não pelo nome do arquivo. Não achá-lo reprova o
     primeiro teste — não dá para deixar passar em silêncio que o e-mail parou
     de ter quem o transmita —, e os outros três ficam pendentes em vez de
     estourar em cascata.
     ------------------------------------------------------------------------ */

  const CANDIDATOS = ['fila-email', 'despachante', 'despacho', 'email-fila'];

  /** Procura o módulo que transmite a fila, sem depender do nome do arquivo. */
  function localizarDespachante() {
    for (const nome of CANDIDATOS) {
      const caminho = path.join(amb.RAIZ, 'server', `${nome}.js`);
      let modulo = null;

      try {
        modulo = require(caminho);
      } catch (e) {
        /* Módulo ausente é o caso esperado; erro de dentro dele tem que
           aparecer, e não ser confundido com ausência. */
        if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(nome)) throw e;
        continue;
      }

      if (modulo && typeof modulo.despachar === 'function') {
        return { modulo, nome: `server/${nome}.js` };
      }
    }

    if (typeof email.despachar === 'function') return { modulo: email, nome: 'server/email.js' };
    return null;
  }

  const despachante = localizarDespachante();
  const semDespachante = despachante ? false : 'não achei o módulo que despacha a fila';

  /* O executor imprime teste pulado como "ok". O sufixo no nome é o que deixa
     visível, na saída da suíte, que a verificação não chegou a rodar — e ele
     some sozinho no dia em que o despachante aparecer. */
  const naFila = (nome) => (semDespachante ? `${nome} — PENDENTE: ${semDespachante}` : nome);

  /**
   * Uma linha nova em 'fila', pelo caminho de verdade, já ESTABILIZADA.
   *
   * enviar() agenda um despacho para o próximo tique, e essa rodada automática
   * correria junto com a que o teste pede — ora incrementando o contador antes
   * da medição, ora marcando um recuo que faria a rodada seguinte pular a
   * linha. Aqui esperamos ela acontecer (o despachante serializa as rodadas:
   * a nossa entra na fila atrás dela) e devolvemos a linha ao estado inicial.
   */
  async function enfileirar(assunto) {
    const r = email.enviar({
      para: 'ana@exemplo.com',
      destino: 'Fila de teste',
      assunto,
      corpo: '<p>Mensagem à espera do despachante.</p>'
    });

    assert.equal(r.status, 'fila', 'a fixture precisa nascer na fila');

    await new Promise((pronto) => setImmediate(pronto));
    await despachante.modulo.despachar();

    db.executar(
      `UPDATE emails_enviados
          SET status = 'fila', tentativas = 0, proxima_tentativa = NULL, erro = NULL
        WHERE id = ?`,
      r.id
    );

    return r.id;
  }

  /** Aponta a configuração de SMTP do banco para onde o teste quiser. */
  function apontarSmtp({ servidor, porta, seguranca = 'SSL' }) {
    db.executar(
      `UPDATE smtp SET servidor_saida = ?, smtp = ?, seguranca = ?, usuario = ?, email = ?
        WHERE id = 1`,
      servidor, porta, seguranca, USUARIO, USUARIO
    );
  }

  /** Só a fila deste bloco, para um teste não herdar a linha do outro. */
  const limparFila = () => db.executar("DELETE FROM emails_enviados WHERE status = 'fila'");

  const tentativasDe = (id) => Number(
    db.um('SELECT * FROM emails_enviados WHERE id = ?', id).tentativas || 0
  );

  it('existe quem despache a fila, e a fila tem contador de tentativas', () => {
    assert.ok(
      despachante,
      'nenhum módulo de server/ exporta despachar(): sem despachante, tudo que '
      + `email.enviar() grava como 'fila' fica parado para sempre. Procurei por `
      + CANDIDATOS.map((c) => `server/${c}.js`).join(', ')
    );

    const colunas = db.todos('PRAGMA table_info(emails_enviados)').map((c) => c.name);
    assert.ok(
      colunas.includes('tentativas'),
      'sem a coluna tentativas não há como distinguir a primeira falha da décima'
    );
  });

  it(naFila('falha temporária devolve o e-mail para a fila com tentativas+1'),
    { skip: semDespachante }, async () => {
      limparFila();

      /* Porta fechada em 127.0.0.1: ECONNREFUSED é falha de rede, e falha de
         rede volta. Nada sai da máquina. */
      apontarSmtp({ servidor: '127.0.0.1', porta: await portaFechada() });

      const id = await enfileirar('Falha temporária');
      assert.equal(tentativasDe(id), 0, 'a fixture começa com o contador zerado');

      await despachante.modulo.despachar();

      const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', id);
      assert.equal(linha.status, 'fila', 'servidor fora do ar não pode perder a mensagem');
      assert.equal(tentativasDe(id), 1, 'a tentativa que falhou tem que ser contada');
      assert.ok(!JSON.stringify(linha).includes(SENHA));
    });

  it(naFila('falha permanente marca o e-mail como falhou'),
    { skip: semDespachante }, async () => {
      limparFila();

      /* Servidor que não oferece STARTTLS: entregar por ali exporia a senha em
         texto puro, e tentar de novo daqui a uma hora não muda isso. */
      const { servidor } = await subirFalso({ starttls: false, usuario: USUARIO, senha: SENHA });
      apontarSmtp({ servidor: '127.0.0.1', porta: servidor.porta, seguranca: 'nenhuma' });

      const id = await enfileirar('Falha permanente');

      await despachante.modulo.despachar();

      const linha = db.um('SELECT * FROM emails_enviados WHERE id = ?', id);
      assert.equal(linha.status, 'falhou', 'falha sem volta não pode ficar tentando para sempre');
      assert.ok(linha.erro, 'o motivo tem que ficar registrado para o admin ver');
      assert.ok(!String(linha.erro).includes(SENHA));
      assert.ok(!String(linha.erro).includes(SENHA_B64));
      assert.equal(servidor.recebidas.length, 0, 'nada podia ter sido transmitido');
    });

  it(naFila('despachar() nunca lança, nem com a configuração quebrada'),
    { skip: semDespachante }, async () => {
      limparFila();
      const id = await enfileirar('Configuração quebrada');

      /* Sem servidor de saída não há para onde ir. Quem chama despachar() é um
         temporizador solto, sem rota nem try/catch por cima: uma exceção aqui
         derrubaria o processo inteiro. */
      apontarSmtp({ servidor: '', porta: null, seguranca: 'SSL' });

      const { erro, linhas } = await capturarConsole(() => despachante.modulo.despachar());

      assert.equal(erro, null, `${despachante.nome} não pode lançar: ele roda solto, fora de rota`);
      assert.ok(!linhas.join('\n').includes(SENHA));

      /* E a fila continua intacta: configuração faltando é para ser corrigida
         no painel, não motivo para jogar a mensagem fora. */
      assert.equal(db.valor('SELECT status FROM emails_enviados WHERE id = ?', id), 'fila');
    });
});
