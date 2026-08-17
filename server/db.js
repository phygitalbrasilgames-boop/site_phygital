/* ==========================================================================
   PHYGITAL BRASIL — ACESSO AO BANCO

   SQLite pelo módulo node:sqlite, embutido no Node 22.5+. Escolhido para o
   projeto não ganhar nenhuma dependência npm (nem compilação nativa, que é
   justamente o que costuma quebrar no Windows).

   node:sqlite é síncrono. Isso é proposital e adequado aqui: SQLite é um
   arquivo local, cada consulta leva microssegundos, e código síncrono elimina
   toda uma classe de erro de concorrência. Se um dia o banco virar Postgres,
   este módulo é o único lugar que muda.
   ========================================================================== */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PASTA_DADOS = process.env.PHYGITAL_DADOS || path.join(RAIZ, 'dados');
const ARQUIVO = path.join(PASTA_DADOS, 'phygital.db');

let bd = null;

/* --------------------------------------------------------------------------
   ABERTURA
   -------------------------------------------------------------------------- */

function abrir() {
  if (bd) return bd;

  fs.mkdirSync(PASTA_DADOS, { recursive: true });
  bd = new DatabaseSync(ARQUIVO);

  /* O esquema é idempotente (CREATE TABLE IF NOT EXISTS), então aplicar em
     toda subida mantém um banco antigo em dia sem migração manual. */
  bd.exec(fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8'));

  return bd;
}

function fechar() {
  if (bd) { bd.close(); bd = null; }
}

/* --------------------------------------------------------------------------
   CONSULTAS

   Todas recebem SQL com parâmetros nomeados ou posicionais — nunca
   interpolação de string. É o que impede injeção de SQL.
   -------------------------------------------------------------------------- */

/** Todas as linhas. */
function todos(sql, ...params) {
  return abrir().prepare(sql).all(...params);
}

/** A primeira linha, ou null. */
function um(sql, ...params) {
  const r = abrir().prepare(sql).get(...params);
  return r === undefined ? null : r;
}

/** Uma única coluna da primeira linha. Útil para COUNT(*). */
function valor(sql, ...params) {
  const r = um(sql, ...params);
  if (!r) return null;
  return r[Object.keys(r)[0]];
}

/** INSERT/UPDATE/DELETE. Devolve { changes, lastInsertRowid }. */
function executar(sql, ...params) {
  return abrir().prepare(sql).run(...params);
}

/** DDL ou vários comandos de uma vez. */
function bruto(sql) {
  return abrir().exec(sql);
}

/**
 * Roda `fn` dentro de uma transação. Confirma no fim, desfaz em qualquer erro.
 * Aceita aninhamento usando SAVEPOINT, para que uma rota possa chamar uma
 * função que também transaciona sem quebrar a de fora.
 */
let profundidade = 0;
function transacao(fn) {
  const banco = abrir();
  const aninhada = profundidade > 0;
  const nome = 'sp_' + profundidade;

  banco.exec(aninhada ? `SAVEPOINT ${nome}` : 'BEGIN');
  profundidade++;

  try {
    const r = fn();
    profundidade--;
    banco.exec(aninhada ? `RELEASE ${nome}` : 'COMMIT');
    return r;
  } catch (erro) {
    profundidade--;
    try {
      banco.exec(aninhada ? `ROLLBACK TO ${nome}` : 'ROLLBACK');
    } catch (_) { /* a transação já pode ter caído sozinha */ }
    throw erro;
  }
}

/* --------------------------------------------------------------------------
   APOIO

   O banco guarda 0/1 e JSON em texto; o front-end espera booleano e objeto.
   A conversão fica concentrada aqui para não vazar para as rotas.
   -------------------------------------------------------------------------- */

const bool = (v) => v === 1 || v === true || v === '1';
const paraBool = (v) => (v ? 1 : 0);

function json(texto, padrao = null) {
  if (texto === null || texto === undefined || texto === '') return padrao;
  try { return JSON.parse(texto); } catch (_) { return padrao; }
}

const paraJson = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/** Remove chaves undefined — o node:sqlite recusa undefined como parâmetro. */
function limpar(obj) {
  const saida = {};
  for (const [k, v] of Object.entries(obj)) saida[k] = v === undefined ? null : v;
  return saida;
}

const agora = () => new Date().toISOString();

module.exports = {
  abrir, fechar, ARQUIVO, PASTA_DADOS,
  todos, um, valor, executar, bruto, transacao,
  bool, paraBool, json, paraJson, limpar, agora
};
