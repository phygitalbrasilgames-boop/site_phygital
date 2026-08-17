#!/usr/bin/env node
/* ==========================================================================
   PHYGITAL BRASIL — SUÍTE DE TESTES

   Uso:  node testes/executar.js            (ou: npm test)
         node testes/executar.js 06         roda só os arquivos que casam com "06"
         node testes/executar.js inscricoes

   O que acontece aqui, em ordem:

     1. cria uma pasta temporária e aponta PHYGITAL_DADOS para ela — TEM que
        ser antes de qualquer require do servidor, porque server/db.js resolve
        o caminho do banco no momento em que é carregado;
     2. semeia esse banco descartável;
     3. sobe o servidor de verdade numa porta livre;
     4. roda os arquivos de testes/casos/ com o executor do node:test,
        em processo único (isolation: 'none') e um de cada vez;
     5. imprime um resumo em português e apaga a pasta.

   Processo único é proposital: o servidor, o banco e os testes compartilham a
   mesma conexão SQLite. Em processos separados, dois donos escrevendo no mesmo
   arquivo trocariam falha de teste por SQLITE_BUSY intermitente.

   Sem nenhuma dependência de npm: node:test, node:assert e o resto dos
   embutidos.
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* --------------------------------------------------------------------------
   BANCO DESCARTÁVEL

   Fora do projeto de propósito: uma suíte que escreve em ./dados apagaria o
   banco de desenvolvimento de quem a rodou sem ler este arquivo.
   -------------------------------------------------------------------------- */

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'phygital-testes-'));

process.env.PHYGITAL_DADOS = PASTA;
process.env.PHYGITAL_MODO = 'dev';          /* devolve o código de verificação no corpo */
process.env.PHYGITAL_ADMIN_SENHA = 'Arena2026Nacional';
process.env.PHYGITAL_COMPETIDOR_SENHA = 'Quadra2026Digital';

const { run } = require('node:test');
const ambiente = require('./apoio/ambiente');

const CASOS = path.join(__dirname, 'casos');

/* --------------------------------------------------------------------------
   SAÍDA

   Cores só quando a saída é um terminal: num arquivo de log ou num pipe do CI,
   código ANSI vira sujeira.
   -------------------------------------------------------------------------- */

const COR = process.stdout.isTTY && !process.env.NO_COLOR;
const tingir = (codigo, texto) => (COR ? `[${codigo}m${texto}[0m` : texto);
const verde = (t) => tingir('32', t);
const vermelho = (t) => tingir('31', t);
const cinza = (t) => tingir('90', t);
const forte = (t) => tingir('1', t);

const LINHA = '─'.repeat(64);

/** '03-autenticacao.js' → 'autenticacao' */
const rotuloDoArquivo = (arquivo) => path.basename(arquivo, '.js').replace(/^\d+-/, '');

/* --------------------------------------------------------------------------
   SELEÇÃO DE ARQUIVOS
   -------------------------------------------------------------------------- */

function arquivosDeTeste(filtros) {
  const todos = fs.readdirSync(CASOS)
    .filter((nome) => nome.endsWith('.js'))
    .sort()                              /* o prefixo numérico é a ordem de execução */
    .map((nome) => path.join(CASOS, nome));

  if (!filtros.length) return todos;
  return todos.filter((arquivo) => filtros.some((f) => path.basename(arquivo).includes(f)));
}

/* --------------------------------------------------------------------------
   EXECUÇÃO
   -------------------------------------------------------------------------- */

async function principal() {
  const filtros = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const arquivos = arquivosDeTeste(filtros);

  if (!arquivos.length) {
    console.error(`Nenhum arquivo de teste casa com: ${filtros.join(', ')}`);
    return 1;
  }

  console.log('');
  console.log(forte('  SUÍTE DE TESTES — PHYGITAL BRASIL'));
  console.log(`  ${LINHA}`);
  console.log(`  Banco temporário: ${PASTA}`);

  const base = await ambiente.subir();
  console.log(`  Servidor:         ${base}`);
  console.log(`  Arquivos:         ${arquivos.length}`);
  console.log(`  ${LINHA}`);

  const inicio = Date.now();
  const grupos = [];              /* um por arquivo, na ordem de execução */
  const reprovados = [];
  let arquivoAtual = null;

  const fluxo = run({
    files: arquivos,
    isolation: 'none',            /* mesmo processo: o servidor e o banco são um só */
    concurrency: 1,
    timeout: 120000
  });

  const grupoDe = (arquivo) => {
    if (arquivoAtual !== arquivo) {
      arquivoAtual = arquivo;
      console.log('');
      console.log(forte(`  ${rotuloDoArquivo(arquivo).toUpperCase()}`));
      grupos.push({ arquivo, ok: 0, falhas: 0 });
    }
    return grupos[grupos.length - 1];
  };

  fluxo.on('test:pass', (dado) => {
    if (dado.details.type === 'suite') return;      /* o grupo já foi contado pelos filhos */
    const grupo = grupoDe(dado.file);
    grupo.ok += 1;
    console.log(`    ${verde('ok')}    ${'  '.repeat(Math.max(0, dado.nesting - 1))}${dado.name}`);
  });

  fluxo.on('test:fail', (dado) => {
    const erro = dado.details.error;
    const mensagem = String((erro && erro.message) || erro || 'sem mensagem');

    /* Um describe que falha porque um teste dentro dele falhou não é uma falha
       nova: os filhos já foram reportados. Só interessa quando o próprio corpo
       do grupo estourou (erro de fixture, por exemplo). */
    if (dado.details.type === 'suite' && /subtest[s]? failed/i.test(mensagem)) return;

    const grupo = grupoDe(dado.file);
    grupo.falhas += 1;

    const caminho = `${rotuloDoArquivo(dado.file)} › ${dado.name}`;
    reprovados.push({ caminho, mensagem, erro });

    console.log(`    ${vermelho('FALHA')} ${'  '.repeat(Math.max(0, dado.nesting - 1))}${dado.name}`);
    console.log(cinza(`          ${mensagem.split('\n')[0]}`));
  });

  /* Saída que os testes ou o servidor produziram no meio do caminho. */
  fluxo.on('test:stderr', (dado) => process.stderr.write(String(dado.message)));

  await new Promise((pronto, falhou) => {
    fluxo.on('end', pronto);
    fluxo.on('error', falhou);
    fluxo.resume();
  });

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  const totalOk = grupos.reduce((s, g) => s + g.ok, 0);
  const totalFalhas = grupos.reduce((s, g) => s + g.falhas, 0);

  /* Suíte que não roda nada não é suíte que passou: sem esta guarda, um erro
     de carregamento que engolisse os arquivos sairia como "APROVADO — 0". */
  if (!totalOk && !totalFalhas) {
    console.log('');
    console.log(vermelho(forte('  NENHUM TESTE FOI EXECUTADO — verifique testes/casos/')));
    console.log('');
    return 1;
  }

  console.log('');
  console.log(`  ${LINHA}`);
  console.log(forte('  RESUMO'));
  console.log('');

  const largura = Math.max(...grupos.map((g) => rotuloDoArquivo(g.arquivo).length), 10);
  for (const grupo of grupos) {
    const nome = rotuloDoArquivo(grupo.arquivo).padEnd(largura);
    const marca = grupo.falhas ? vermelho(`${grupo.falhas} falha(s)`) : verde('tudo certo');
    console.log(`    ${nome}  ${String(grupo.ok).padStart(3)} verificação(ões)   ${marca}`);
  }

  if (reprovados.length) {
    console.log('');
    console.log(vermelho(forte('  REPROVAÇÕES')));
    reprovados.forEach((r, i) => {
      console.log('');
      console.log(`    ${i + 1}. ${r.caminho}`);
      String(r.mensagem).split('\n').slice(0, 8).forEach((l) => console.log(cinza(`       ${l}`)));
    });
  }

  console.log('');
  console.log(`  ${LINHA}`);
  console.log(
    totalFalhas
      ? vermelho(forte(`  REPROVADO — ${totalFalhas} de ${totalOk + totalFalhas} verificação(ões) falhou/falharam em ${segundos}s`))
      : verde(forte(`  APROVADO — ${totalOk} verificações em ${segundos}s`))
  );
  console.log('');

  return totalFalhas ? 1 : 0;
}

/* --------------------------------------------------------------------------
   FAXINA

   O banco fica em pasta temporária e vai embora aqui. `descer` fecha a conexão
   antes: no Windows, apagar um arquivo SQLite ainda aberto falha com EBUSY.
   -------------------------------------------------------------------------- */

async function limpar() {
  try { await ambiente.descer(); } catch (_) { /* já pode ter caído */ }
  try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch (_) { /* sem drama */ }
}

principal()
  .then(async (codigo) => {
    await limpar();
    process.exitCode = codigo;
  })
  .catch(async (e) => {
    console.error('');
    console.error(vermelho(forte('  A SUÍTE NÃO CHEGOU AO FIM')));
    console.error(e);
    await limpar();
    process.exitCode = 1;
  });
