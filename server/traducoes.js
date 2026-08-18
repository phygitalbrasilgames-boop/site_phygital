/* ==========================================================================
   PHYGITAL BRASIL — IDIOMAS E TRADUÇÃO DO CONTEÚDO CADASTRADO

   O português é a língua de origem e continua morando na coluna normal de cada
   tabela. Inglês e espanhol vivem numa ÚNICA tabela genérica:

     traducoes(tabela, registro_id, campo, idioma, texto, atualizado_em)

   A alternativa — uma coluna por idioma em cada tabela — custaria dezenas de
   colunas, mudaria toda tela de cadastro e obrigaria uma migração a cada novo
   idioma. Aqui, acrescentar um idioma é acrescentar uma string em IDIOMAS.

   O FALLBACK É OBRIGATÓRIO: campo sem tradução volta em português. Meia
   tradução tem que virar meia tela em português, nunca tela vazia — e é por
   isso que texto vazio APAGA a linha em vez de gravar ''.
   ========================================================================== */
'use strict';

const db = require('./db');

/* Russo foi cogitado e descartado pelo cliente. */
const IDIOMAS = ['pt', 'en', 'es'];
const IDIOMA_PADRAO = 'pt';

/* Só os traduzíveis: 'pt' é a origem, guardada na tabela de negócio. */
const IDIOMAS_TRADUZIVEIS = IDIOMAS.filter((i) => i !== IDIOMA_PADRAO);

const NOME_COOKIE = 'phygital_idioma';

/* --------------------------------------------------------------------------
   CAMPOS TRADUZÍVEIS

   Constante única: a API de tradução, a leitura do conteúdo e a tela do admin
   leem esta mesma lista. Acrescentar um campo aqui é acrescentá-lo nos três
   lugares de uma vez.

   As chaves são NOMES DE COLUNA do banco (não do front-end), porque a troca
   acontece na linha crua, antes de server/mapa.js montar o objeto — assim toda
   rota que já mapeia aquela tabela ganha tradução sem mudar de forma.

   modelos_email entra na mesma tabela em vez de duplicar linha por idioma: o
   modelo é identificado por id, e duplicar quebraria toda referência a ele.
   -------------------------------------------------------------------------- */

const CAMPOS_TRADUZIVEIS = {
  campeonatos:   ['nome', 'descricao', 'local', 'termos'],
  posts:         ['titulo', 'resumo', 'corpo'],
  eventos:       ['titulo', 'local'],
  categorias:    ['nome', 'descricao'],
  banners_site:  ['titulo', 'texto', 'eyebrow', 'botao', 'botao2'],
  banners:       ['titulo'],
  parceiros:     ['tipo'],
  modelos_email: ['assunto', 'corpo']
};

const TABELAS_TRADUZIVEIS = Object.keys(CAMPOS_TRADUZIVEIS);

/* Teto de marcadores por consulta. O SQLite aceita muito mais, mas quebrar o
   IN em blocos mantém o custo previsível quando a lista cresce. */
const LOTE = 400;

/* --------------------------------------------------------------------------
   NORMALIZAÇÃO

   Tudo que chega de fora (query, cookie, cabeçalho, corpo de requisição) passa
   por aqui. Valor desconhecido vira null, e quem chama decide o que fazer —
   a resolução da requisição trata null como "não informado" e segue para a
   próxima fonte, terminando em 'pt'.
   -------------------------------------------------------------------------- */

/** 'pt-BR', 'EN_us', 'es-419' → 'pt' | 'en' | 'es'. Qualquer outro → null. */
function normalizar(valor) {
  if (valor === null || valor === undefined) return null;
  const bruto = String(valor).trim().toLowerCase();
  if (!bruto) return null;
  const base = bruto.split(/[-_]/)[0];
  return IDIOMAS.includes(base) ? base : null;
}

/** Idioma válido ou o padrão. Para quando não existe "não informado". */
const normalizarOuPadrao = (valor) => normalizar(valor) || IDIOMA_PADRAO;

/**
 * Melhor idioma de um Accept-Language ('pt-BR,pt;q=0.9,en-US;q=0.8').
 * Ordena por q e devolve o primeiro que conhecemos; '*' e q=0 não contam.
 */
function deAccept(cabecalho) {
  if (!cabecalho) return null;

  const itens = String(cabecalho).split(',').map((parte) => {
    const pedacos = parte.trim().split(';');
    const q = pedacos.slice(1)
      .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p))
      .find(Boolean);
    return { marca: pedacos[0].trim(), q: q ? Number(q[1]) : 1 };
  });

  /* sort estável no Node: entre dois q iguais vence quem veio antes. */
  itens.sort((a, b) => b.q - a.q);

  for (const item of itens) {
    if (!(item.q > 0)) continue;
    const idioma = normalizar(item.marca);
    if (idioma) return idioma;
  }
  return null;
}

/* --------------------------------------------------------------------------
   LEITURA
   -------------------------------------------------------------------------- */

/** Map: registro_id → { campo: texto }. Uma consulta por lote de ids. */
function buscarTextos(tabela, ids, idioma) {
  const indice = new Map();

  for (let i = 0; i < ids.length; i += LOTE) {
    const bloco = ids.slice(i, i + LOTE);
    const linhas = db.todos(
      `SELECT registro_id, campo, texto FROM traducoes
        WHERE tabela = ? AND idioma = ? AND registro_id IN (${bloco.map(() => '?').join(', ')})`,
      tabela, idioma, ...bloco
    );

    for (const l of linhas) {
      if (!indice.has(l.registro_id)) indice.set(l.registro_id, {});
      indice.get(l.registro_id)[l.campo] = l.texto;
    }
  }

  return indice;
}

/**
 * Troca os campos traduzíveis pela versão no idioma pedido.
 *
 * Aceita uma linha ou um array de linhas e devolve no mesmo formato. Nada é
 * mutado: a linha só é copiada quando existe ao menos uma tradução para ela,
 * então o caminho comum (site em português) não paga cópia nenhuma.
 *
 * Campo sem tradução — ou com tradução vazia — permanece em português.
 */
function traduzir(tabela, linhas, idioma) {
  const campos = CAMPOS_TRADUZIVEIS[tabela];
  const alvo = normalizar(idioma);
  const unica = !Array.isArray(linhas);
  const lista = unica ? [linhas] : linhas;

  if (!campos || !alvo || alvo === IDIOMA_PADRAO || !lista.length) return linhas;

  const ids = [...new Set(lista.filter(Boolean).map((l) => String(l.id)))];
  if (!ids.length) return linhas;

  const textos = buscarTextos(tabela, ids, alvo);
  if (!textos.size) return linhas;

  const trocadas = lista.map((linha) => {
    if (!linha) return linha;
    const doRegistro = textos.get(String(linha.id));
    if (!doRegistro) return linha;

    let copia = null;
    for (const campo of campos) {
      const texto = doRegistro[campo];
      if (texto === undefined || texto === null || texto === '') continue;
      if (!copia) copia = { ...linha };
      copia[campo] = texto;
    }
    return copia || linha;
  });

  return unica ? trocadas[0] : trocadas;
}

/**
 * Tudo que existe para um registro, pronto para a tela do admin:
 *   { en: { nome: '...', descricao: '' }, es: { ... } }
 * Campo sem tradução vem como '' para o formulário nascer completo.
 */
function mapaDe(tabela, registroId) {
  const campos = CAMPOS_TRADUZIVEIS[tabela] || [];
  const saida = {};

  for (const idioma of IDIOMAS_TRADUZIVEIS) {
    saida[idioma] = {};
    for (const campo of campos) saida[idioma][campo] = '';
  }

  const linhas = db.todos(
    'SELECT campo, idioma, texto FROM traducoes WHERE tabela = ? AND registro_id = ?',
    tabela, String(registroId)
  );

  for (const l of linhas) {
    /* Ignora o que não está mais na lista de campos traduzíveis: a linha antiga
       continua no banco, mas não volta para a tela como campo fantasma. */
    if (saida[l.idioma] && campos.includes(l.campo)) saida[l.idioma][l.campo] = l.texto || '';
  }

  return saida;
}

/* --------------------------------------------------------------------------
   ESCRITA
   -------------------------------------------------------------------------- */

/**
 * Grava uma tradução. Texto vazio APAGA a linha — é assim que o admin devolve
 * o campo ao português, e é o que mantém o fallback previsível.
 * @returns 'gravou' | 'apagou' | 'nada'
 */
function salvar(tabela, registroId, campo, idioma, texto) {
  const limpo = texto === null || texto === undefined ? '' : String(texto).trim();
  const id = String(registroId);

  if (!limpo) {
    const r = db.executar(
      'DELETE FROM traducoes WHERE tabela = ? AND registro_id = ? AND campo = ? AND idioma = ?',
      tabela, id, campo, idioma
    );
    return r.changes ? 'apagou' : 'nada';
  }

  db.executar(
    `INSERT INTO traducoes (tabela, registro_id, campo, idioma, texto, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tabela, registro_id, campo, idioma)
     DO UPDATE SET texto = excluded.texto, atualizado_em = excluded.atualizado_em`,
    tabela, id, campo, idioma, limpo, db.agora()
  );
  return 'gravou';
}

/**
 * Apaga tudo de um registro. Chamado na exclusão definitiva: a tabela é
 * genérica e não tem chave estrangeira para lugar nenhum, então o ON DELETE
 * CASCADE do esquema não alcança estas linhas.
 */
function apagarRegistro(tabela, registroId) {
  return db.executar(
    'DELETE FROM traducoes WHERE tabela = ? AND registro_id = ?', tabela, String(registroId)
  ).changes;
}

/** Quantas traduções existem, por tabela e idioma. Alimenta painel e testes. */
function resumo() {
  return db.todos(
    `SELECT tabela, idioma, COUNT(*) AS total
       FROM traducoes GROUP BY tabela, idioma ORDER BY tabela, idioma`
  );
}

module.exports = {
  IDIOMAS, IDIOMA_PADRAO, IDIOMAS_TRADUZIVEIS, NOME_COOKIE,
  CAMPOS_TRADUZIVEIS, TABELAS_TRADUZIVEIS,
  normalizar, normalizarOuPadrao, deAccept,
  traduzir, mapaDe, salvar, apagarRegistro, resumo
};
