/* ==========================================================================
   PHYGITAL BRASIL — SERVIDOR SMTP FALSO (APOIO DE TESTE)

   Serve para exercitar server/smtp.js sem mandar e-mail para pessoa nenhuma.
   Fala o suficiente do RFC 5321 para o cliente completar o percurso inteiro:
   banner, EHLO com extensões, STARTTLS, AUTH PLAIN e LOGIN, MAIL FROM, RCPT TO
   (aceitando ou recusando por endereço), DATA e QUIT.

   Tudo que chega fica em `recebidas`, já com o dot-stuffing DESFEITO — é isso
   que permite comparar, byte a byte, o que o cliente montou com o que o
   servidor recebeu. A forma CRUA, ainda com os pontos dobrados, fica ao lado em
   `dadosCrus`: é a única maneira de provar que o dot-stuffing aconteceu no fio,
   e não só que a mensagem sobreviveu.

   Ele também sabe se comportar mal sob encomenda — recusar AUTH, negar um
   destinatário, devolver 4xx temporário em qualquer etapa, demorar mais do que
   o cliente espera —, que é o que os testes de falha precisam.

   O certificado é autoassinado e gerado na hora, em DER puro com node:crypto,
   porque o projeto não pode ganhar dependência de npm e o Node não traz gerador
   de certificado. Ele vale só para 'localhost' e é descartado quando o processo
   morre — o cliente precisa de permitirCertificadoInvalido para aceitá-lo, o
   que é justamente o escape documentado para servidor com certificado próprio.
   ========================================================================== */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const CRLF = '\r\n';

/* --------------------------------------------------------------------------
   CERTIFICADO AUTOASSINADO (DER na mão)
   -------------------------------------------------------------------------- */

/** Octetos de comprimento do DER: curto até 127, longo acima disso. */
function comprimento(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...conteudo) {
  const corpo = Buffer.concat(conteudo.flat());
  return Buffer.concat([Buffer.from([tag]), comprimento(corpo.length), corpo]);
}

const seq = (...p) => tlv(0x30, p);
const conjunto = (...p) => tlv(0x31, p);
const inteiro = (buf) => tlv(0x02, [buf[0] & 0x80 ? Buffer.from([0]) : Buffer.alloc(0), buf]);
const bits = (buf) => tlv(0x03, [Buffer.from([0]), buf]);
const octetos = (buf) => tlv(0x04, [buf]);
const nulo = Buffer.from([0x05, 0x00]);
const booleano = (v) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
const contexto = (n, ...p) => tlv(0xa0 | n, p);

function oid(dotted) {
  const partes = dotted.split('.').map(Number);
  const bytes = [40 * partes[0] + partes[1]];

  for (const p of partes.slice(2)) {
    const pilha = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { pilha.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    bytes.push(...pilha);
  }
  return tlv(0x06, [Buffer.from(bytes)]);
}

function utcTime(data) {
  const d = (n) => String(n).padStart(2, '0');
  const texto = `${d(data.getUTCFullYear() % 100)}${d(data.getUTCMonth() + 1)}${d(data.getUTCDate())}`
    + `${d(data.getUTCHours())}${d(data.getUTCMinutes())}${d(data.getUTCSeconds())}Z`;
  return tlv(0x17, [Buffer.from(texto, 'ascii')]);
}

/** Nome X.501 com um CN só. */
const nomeX501 = (cn) => seq(conjunto(seq(oid('2.5.4.3'), tlv(0x0c, [Buffer.from(cn, 'utf8')]))));

const extensao = (id, critica, valorDer) => seq(oid(id), ...(critica ? [booleano(true)] : []), octetos(valorDer));

let cacheCertificado = null;

/** Certificado autoassinado para localhost/127.0.0.1, válido por um dia. */
function certificado() {
  if (cacheCertificado) return cacheCertificado;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const algoritmo = seq(oid('1.2.840.113549.1.1.11'), nulo);   /* sha256WithRSAEncryption */
  const nome = nomeX501('localhost');
  const agora = Date.now();

  /* subjectAltName: dNSName é [2] primitivo, iPAddress é [7] primitivo. */
  const altNames = seq(
    tlv(0x82, [Buffer.from('localhost', 'ascii')]),
    tlv(0x87, [Buffer.from([127, 0, 0, 1])])
  );

  const tbs = seq(
    contexto(0, inteiro(Buffer.from([2]))),                    /* versão v3 */
    inteiro(crypto.randomBytes(8)),
    algoritmo,
    nome,
    seq(utcTime(new Date(agora - 3600000)), utcTime(new Date(agora + 86400000))),
    nome,
    spki,
    contexto(3, seq(
      extensao('2.5.29.19', true, seq(booleano(true))),        /* basicConstraints: CA */
      extensao('2.5.29.17', false, altNames)
    ))
  );

  const der = seq(tbs, algoritmo, bits(crypto.sign('sha256', tbs, privateKey)));
  const base64 = der.toString('base64').match(/.{1,64}/g).join('\n');

  cacheCertificado = {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
  return cacheCertificado;
}

/* --------------------------------------------------------------------------
   O SERVIDOR
   -------------------------------------------------------------------------- */

/**
 * @param {object} opcoes
 *   tls         — TLS implícito, como a porta 465
 *   starttls    — anuncia e aceita STARTTLS (só faz sentido sem TLS implícito)
 *   usuario     — quando ausente, o servidor não exige autenticação
 *   senha
 *   mecanismos  — o que anunciar no 'AUTH' do EHLO
 *   recusar     — endereços que o RCPT TO recusa, e com que código
 *   recusarAuth — nega a autenticação mesmo com a credencial certa
 *   respostas   — troca a resposta de uma etapa por outra, para forçar falha:
 *                 { BANNER, EHLO, AUTH, MAIL, RCPT, DATA, FIM }. 'FIM' é a
 *                 resposta ao ponto final do DATA.
 *   atrasos     — milissegundos de espera antes de responder a cada etapa,
 *                 pelas mesmas chaves. É assim que se estoura o timeout do
 *                 cliente sem depender da rede.
 */
function criar(opcoes = {}) {
  const {
    tls: implicito = false, starttls = true,
    usuario = null, senha = null,
    mecanismos = 'PLAIN LOGIN',
    recusar = {},
    recusarAuth = false,
    respostas = {},
    atrasos = {},
    dominio = 'falso.phygital.local'
  } = opcoes;

  const recebidas = [];
  const comandos = [];
  const conexoes = new Set();
  const relogios = new Set();
  const credenciais = certificado();

  /** Resposta configurada para a etapa; `null` quando ninguém a trocou. */
  const respostaDe = (etapa, padrao) =>
    (Object.prototype.hasOwnProperty.call(respostas, etapa) ? respostas[etapa] : padrao);

  function atender(socketInicial, jaCifrado) {
    let socket = socketInicial;
    let cifrado = jaCifrado;
    let sobra = '';

    const estado = {
      autenticado: !usuario, de: null, para: [],
      dados: [], crus: [], comandos: [], modo: 'comando', pendente: null
    };

    /* Soquete já destruído acontece o tempo todo aqui: o cliente desiste no
       timeout e o atraso agendado vence depois disso. */
    const escrever = (texto) => { if (!socket.destroyed) socket.write(texto); };

    /**
     * Executa `acao` agora ou depois do atraso pedido para a etapa. O
     * temporizador é unref: um atraso pendente não pode segurar o fim da suíte.
     */
    function agendar(etapa, acao) {
      const ms = Number(atrasos[etapa]) || 0;
      if (!ms) { acao(); return; }

      const relogio = setTimeout(() => { relogios.delete(relogio); acao(); }, ms);
      if (relogio.unref) relogio.unref();
      relogios.add(relogio);
    }

    const responder = (linha, etapa) => agendar(etapa, () => escrever(linha + CRLF));

    function saudacao() {
      const forcada = respostaDe('EHLO', null);
      if (forcada) { responder(forcada, 'EHLO'); return; }

      const linhas = [`${dominio} pronto`, 'SIZE 10485760'];
      if (!cifrado && starttls) linhas.push('STARTTLS');
      if (usuario) linhas.push(`AUTH ${mecanismos}`);
      linhas.push('8BITMIME');

      /* Multi-linha: só a última troca o hífen por espaço. Vai num write só
         de propósito — resposta partida em vários pacotes é justamente o que o
         leitor por linha do cliente tem que aguentar, e isso já é exercitado
         pelo banner separado. */
      agendar('EHLO', () => escrever(
        linhas.map((l, i) => `250${i === linhas.length - 1 ? ' ' : '-'}${l}`).join(CRLF) + CRLF
      ));
    }

    function conferir(usuarioRecebido, senhaRecebida) {
      const forcada = respostaDe('AUTH', null);
      if (forcada) {
        estado.autenticado = forcada.startsWith('2');
        responder(forcada, 'AUTH');
        return;
      }

      if (!recusarAuth && usuarioRecebido === usuario && senhaRecebida === senha) {
        estado.autenticado = true;
        responder('235 2.7.0 autenticado', 'AUTH');
      } else {
        responder('535 5.7.8 usuário ou senha inválidos', 'AUTH');
      }
    }

    function tratarComando(linha) {
      /* Registro do que chegou, inclusive o passo conversado do AUTH — este
         log é do servidor de mentira, existe para o teste inspecionar e não sai
         daqui. */
      comandos.push(linha);
      estado.comandos.push(linha);

      /* Passo intermediário de um AUTH conversado. */
      if (estado.pendente) {
        const passo = estado.pendente;
        estado.pendente = null;
        const valor = Buffer.from(linha.trim(), 'base64').toString('utf8');

        if (passo.tipo === 'plain') {
          const [, u, s] = valor.split('\0');
          conferir(u, s);
        } else if (passo.tipo === 'login-usuario') {
          estado.pendente = { tipo: 'login-senha', usuario: valor };
          responder('334 UGFzc3dvcmQ6');
        } else {
          conferir(passo.usuario, valor);
        }
        return;
      }

      const [verbo, ...resto] = linha.split(/\s+/);
      const argumento = resto.join(' ');
      const comando = String(verbo || '').toUpperCase();

      if (comando === 'EHLO') { saudacao(); return; }
      if (comando === 'HELO') { responder(`250 ${dominio}`); return; }
      if (comando === 'NOOP') { responder('250 2.0.0 ok'); return; }
      if (comando === 'RSET') {
        estado.de = null; estado.para = []; estado.dados = [];
        responder('250 2.0.0 limpo');
        return;
      }

      if (comando === 'STARTTLS') {
        if (cifrado || !starttls) { responder('454 4.7.0 STARTTLS indisponível'); return; }
        responder('220 2.0.0 pode começar o TLS');
        subirTls();
        return;
      }

      if (comando === 'AUTH') {
        if (!usuario) { responder('503 5.5.1 autenticação não configurada'); return; }
        const [tipo, inicial] = argumento.split(/\s+/);
        const nome = String(tipo || '').toUpperCase();

        if (nome === 'PLAIN') {
          if (inicial) {
            const [, u, s] = Buffer.from(inicial, 'base64').toString('utf8').split('\0');
            conferir(u, s);
          } else {
            estado.pendente = { tipo: 'plain' };
            responder('334 ');
          }
          return;
        }
        if (nome === 'LOGIN') {
          estado.pendente = { tipo: 'login-usuario' };
          responder('334 VXNlcm5hbWU6');
          return;
        }
        responder('504 5.5.4 mecanismo não suportado');
        return;
      }

      if (comando === 'MAIL') {
        if (!estado.autenticado) { responder('530 5.7.0 autentique-se primeiro'); return; }

        const forcada = respostaDe('MAIL', null);
        if (forcada) { responder(forcada, 'MAIL'); return; }

        estado.de = (argumento.match(/<([^>]*)>/) || [])[1] || '';
        estado.para = []; estado.dados = []; estado.crus = [];
        responder('250 2.1.0 remetente ok', 'MAIL');
        return;
      }

      if (comando === 'RCPT') {
        if (!estado.de) { responder('503 5.5.1 mande MAIL FROM antes'); return; }

        const forcada = respostaDe('RCPT', null);
        if (forcada) { responder(forcada, 'RCPT'); return; }

        const endereco = (argumento.match(/<([^>]*)>/) || [])[1] || '';
        const negado = recusar[endereco] || recusar[endereco.toLowerCase()];

        if (negado) {
          responder(typeof negado === 'string' ? negado : '550 5.1.1 destinatário desconhecido', 'RCPT');
        } else {
          estado.para.push(endereco);
          responder('250 2.1.5 destinatário ok', 'RCPT');
        }
        return;
      }

      if (comando === 'DATA') {
        if (!estado.para.length) { responder('554 5.5.1 sem destinatário válido'); return; }

        /* Só entra em modo de dados quando convida o corpo (3xx); um 4xx aqui
           deixa a conexão em modo de comando, como manda o RFC 5321. */
        const linha3 = respostaDe('DATA', '354 mande a mensagem, termine com <CRLF>.<CRLF>');
        if (String(linha3).startsWith('3')) estado.modo = 'dados';
        responder(linha3, 'DATA');
        return;
      }

      if (comando === 'QUIT') { responder('221 2.0.0 até logo'); socket.end(); return; }

      responder('500 5.5.2 comando desconhecido');
    }

    function tratarDados(linha) {
      if (linha === '.') {
        estado.modo = 'comando';

        const fim = respostaDe('FIM', '250 2.0.0 recebido como 0001');

        recebidas.push({
          de: estado.de,
          para: estado.para.slice(),
          cifrado,
          /* Sem CRLF no fim, para bater exatamente com a saída de montarMime. */
          dados: estado.dados.join(CRLF),
          /* Como veio do fio, com os pontos ainda dobrados. */
          dadosCrus: estado.crus.join(CRLF),
          comandos: estado.comandos.slice(),
          resposta: fim,
          aceita: String(fim).startsWith('2')
        });

        estado.dados = [];
        estado.crus = [];
        responder(fim, 'FIM');
        return;
      }

      estado.crus.push(linha);
      /* Desfaz o dot-stuffing: '..' no começo da linha volta a ser '.'. */
      estado.dados.push(linha.startsWith('..') ? linha.slice(1) : linha);
    }

    function aoReceber(pedaco) {
      sobra += pedaco.toString('utf8');
      let corte;

      while ((corte = sobra.indexOf('\n')) !== -1) {
        let linha = sobra.slice(0, corte);
        sobra = sobra.slice(corte + 1);
        if (linha.endsWith('\r')) linha = linha.slice(0, -1);

        if (estado.modo === 'dados') tratarDados(linha);
        else tratarComando(linha);
      }
    }

    function subirTls() {
      /* Os ouvintes do soquete em claro saem antes do embrulho, senão roubariam
         os bytes que agora são do TLS. O estado é descartado, como manda o
         RFC 3207: o que veio antes do TLS não conta. */
      socket.removeListener('data', aoReceber);
      const cru = socket;

      socket = new tls.TLSSocket(cru, {
        isServer: true,
        secureContext: tls.createSecureContext(credenciais)
      });
      cifrado = true;
      estado.autenticado = !usuario;
      estado.de = null;
      estado.para = [];
      estado.dados = [];
      estado.crus = [];
      sobra = '';

      conexoes.add(socket);
      socket.on('data', aoReceber);
      socket.on('error', () => {});
      socket.on('close', () => conexoes.delete(socket));
    }

    conexoes.add(socket);
    socket.on('data', aoReceber);
    socket.on('error', () => { /* cliente desistiu; nada a fazer */ });
    socket.on('close', () => conexoes.delete(socket));

    responder(respostaDe('BANNER', `220 ${dominio} ESMTP de mentira`), 'BANNER');
  }

  const servidor = implicito
    ? tls.createServer(credenciais, (s) => atender(s, true))
    : net.createServer((s) => atender(s, false));

  servidor.on('error', () => {});

  let porta = 0;

  return {
    recebidas,
    comandos,
    ultima: () => recebidas[recebidas.length - 1] || null,
    get porta() { return porta; },

    ouvir() {
      return new Promise((pronto) => {
        servidor.listen(0, '127.0.0.1', () => {
          porta = servidor.address().port;
          /* Servidor à espera é handle vivo, e handle vivo adia o `beforeExit`
             em que o executor do node:test fecha a rodada. */
          servidor.unref();
          pronto(porta);
        });
      });
    },

    parar() {
      for (const relogio of relogios) clearTimeout(relogio);
      relogios.clear();
      for (const s of conexoes) s.destroy();
      conexoes.clear();
      return new Promise((pronto) => servidor.close(pronto));
    }
  };
}

module.exports = { criar, certificado };
