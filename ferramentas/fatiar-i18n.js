#!/usr/bin/env node
/* Divide site/assets/i18n/pt.json em fatias por área, para a tradução ser feita
   em paralelo sem que um tradutor precise varrer o arquivo inteiro — e sem dois
   deles escreverem no mesmo arquivo ao mesmo tempo.

   Uso:  node ferramentas/fatiar-i18n.js          (gera as fatias)
         node ferramentas/fatiar-i18n.js --juntar (remonta en.json e es.json) */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const I18N = path.join(RAIZ, 'site', 'assets', 'i18n');
const FATIAS = path.join(RAIZ, 'ferramentas', 'i18n-fatias');
const IDIOMAS = ['en', 'es'];

/* A área sai do primeiro arquivo em que a string aparece. Serve para dar
   contexto ao tradutor e para dividir o trabalho — não muda o dicionário. */
function areaDe(contexto) {
  const f = (contexto && contexto.arquivos && contexto.arquivos[0]) || '';
  if (f.includes('/admin/')) return 'admin';
  if (f.includes('/painel/')) return 'painel';
  if (f.includes('/assets/')) return 'assets';
  return 'publico';
}

function fatiar() {
  const pt = JSON.parse(fs.readFileSync(path.join(I18N, 'pt.json'), 'utf8'));
  fs.mkdirSync(FATIAS, { recursive: true });

  const porArea = {};
  const registrar = (area, tipo, chave) => {
    porArea[area] = porArea[area] || { textos: {}, padroes: {} };
    porArea[area][tipo][chave] = '';
  };

  for (const chave of Object.keys(pt.textos || {})) {
    registrar(areaDe(pt.contexto && pt.contexto[chave]), 'textos', chave);
  }
  /* Padrões vão todos juntos: têm marcador {0} e exigem cuidado próprio, então
     concentrar num tradutor só sai mais consistente do que espalhar. */
  for (const chave of Object.keys(pt.padroes || {})) registrar('padroes', 'padroes', chave);

  const resumo = [];
  for (const [area, dados] of Object.entries(porArea)) {
    const n = Object.keys(dados.textos).length + Object.keys(dados.padroes).length;
    resumo.push({ area, strings: n });

    for (const idioma of IDIOMAS) {
      const alvo = path.join(FATIAS, `${idioma}-${area}.json`);
      if (fs.existsSync(alvo)) continue;      /* nunca sobrescreve trabalho feito */
      fs.writeFileSync(alvo, JSON.stringify({
        idioma, area,
        instrucao: 'Preencha cada valor com a tradução. Deixe "" no que não souber: o vazio cai no português.',
        textos: dados.textos,
        padroes: dados.padroes
      }, null, 2) + '\n');
    }
  }

  console.log('fatias em ferramentas/i18n-fatias/ :');
  for (const r of resumo.sort((a, b) => b.strings - a.strings)) {
    console.log(`  ${r.area.padEnd(9)} ${String(r.strings).padStart(5)} strings  ×${IDIOMAS.length} idiomas`);
  }
  console.log(`  ${'TOTAL'.padEnd(9)} ${String(resumo.reduce((s, r) => s + r.strings, 0)).padStart(5)} strings`);
}

function juntar() {
  const pt = JSON.parse(fs.readFileSync(path.join(I18N, 'pt.json'), 'utf8'));

  for (const idioma of IDIOMAS) {
    const textos = {};
    const padroes = {};
    /* Parte das chaves do pt.json, não das fatias: assim uma fatia esquecida
       aparece como vazio (que cai no português) em vez de sumir do dicionário. */
    for (const k of Object.keys(pt.textos || {})) textos[k] = '';
    for (const k of Object.keys(pt.padroes || {})) padroes[k] = '';

    let preenchidos = 0;
    for (const arq of fs.readdirSync(FATIAS).filter((f) => f.startsWith(idioma + '-'))) {
      const fatia = JSON.parse(fs.readFileSync(path.join(FATIAS, arq), 'utf8'));
      for (const [k, v] of Object.entries(fatia.textos || {})) {
        if (v && k in textos) { textos[k] = v; preenchidos++; }
      }
      for (const [k, v] of Object.entries(fatia.padroes || {})) {
        if (v && k in padroes) { padroes[k] = v; preenchidos++; }
      }
    }

    const total = Object.keys(textos).length + Object.keys(padroes).length;
    fs.writeFileSync(path.join(I18N, `${idioma}.json`), JSON.stringify({
      idioma, versao: pt.versao, geradoEm: new Date().toISOString(),
      resumo: { textos: Object.keys(textos).length, padroes: Object.keys(padroes).length, preenchidos },
      textos, padroes
    }, null, 2) + '\n');

    const pct = Math.round((preenchidos / total) * 100);
    console.log(`  ${idioma}.json: ${preenchidos}/${total} preenchidos (${pct}%)`);
  }
}

if (process.argv.includes('--juntar')) juntar();
else fatiar();
