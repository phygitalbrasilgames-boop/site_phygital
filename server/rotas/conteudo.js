/* ==========================================================================
   PHYGITAL BRASIL — CONTEÚDO EDITORIAL E BANNERS

   Blog (posts e categorias), galeria de eventos, parceiros e os dois tipos de
   banner: o do painel do competidor e o do hero do site público.

   Seis recursos com o mesmo ciclo — listar, ler, criar, atualizar, arquivar —
   e diferenças pequenas. Em vez de repetir trinta rotas quase iguais, cada
   recurso é descrito em RECURSOS e registrarCrud() monta os caminhos a partir
   da descrição. O que é próprio de um recurso vive na descrição dele:
   validação, ordenação e os ganchos de gravação e de arquivamento.

   Duas regras valem para todos:

   · Nada é apagado. DELETE grava arquivado_em (histórico do administrador),
     como o front-end já fazia com arquivar/restaurar/excluirDefinitivo.
   · A leitura sem sessão só enxerga o que está no ar: arquivado_em nulo,
     post publicado e banner ativo. Um administrador amplia isso com ?tudo=1
     (traz rascunho e inativo) e ?arquivados=1 (traz só o histórico).

   Escrita é sempre de administrador master: nenhuma das permissões usadas
   aqui está nas listas de gestor ou operação em auth.PERMISSOES, e master
   tem '*'.
   ========================================================================== */
'use strict';

const db = require('../db');
const mapa = require('../mapa');
const regras = require('../regras');
const { erro400, erro404, erro409 } = require('../http');

/* Teto de itens por página. Sem limite, /api/posts cresce junto com o blog e
   uma listagem passa a carregar o corpo inteiro de centenas de publicações. */
const LIMITE_PADRAO = 200;
const LIMITE_MAX = 500;

/* --------------------------------------------------------------------------
   VALIDAÇÃO DE CAMPOS

   Os rótulos entram no texto do erro entre aspas ("Preencha o campo
   "Título".") para o mesmo helper servir a campo masculino e feminino sem
   concordância errada.
   -------------------------------------------------------------------------- */

const informado = (corpo, campo) => Object.prototype.hasOwnProperty.call(corpo, campo);

function texto(valor, rotulo, { obrigatorio = false, max = 200 } = {}) {
  const s = valor === null || valor === undefined ? '' : String(valor).trim();

  if (!s) {
    if (obrigatorio) throw erro400(`Preencha o campo "${rotulo}".`);
    return '';
  }
  if (s.length > max) {
    throw erro400(`O campo "${rotulo}" passa do limite de ${max} caracteres.`);
  }
  return s;
}

function inteiro(valor, rotulo, { min = 0, max = 1000000, padrao = null } = {}) {
  if (valor === null || valor === undefined || valor === '') {
    if (padrao === null) throw erro400(`Preencha o campo "${rotulo}".`);
    return padrao;
  }
  const n = Number(valor);
  if (!Number.isInteger(n)) throw erro400(`O campo "${rotulo}" precisa ser um número inteiro.`);
  if (n < min || n > max) throw erro400(`O campo "${rotulo}" precisa estar entre ${min} e ${max}.`);
  return n;
}

const booleano = (v) => v === true || v === 1 || v === '1' || v === 'true';

function dataISO(valor, rotulo) {
  const s = texto(valor, rotulo, { max: 10 });
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00`).getTime())) {
    throw erro400(`O campo "${rotulo}" precisa estar no formato AAAA-MM-DD.`);
  }
  return s;
}

function cor(valor, rotulo) {
  const s = texto(valor, rotulo, { max: 7 });
  if (!s) return '';
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s)) {
    throw erro400(`O campo "${rotulo}" precisa ser uma cor em hexadecimal, como #009B4A.`);
  }
  return s.toUpperCase();
}

/* Endereços vão parar em href e em src de páginas públicas, então o esquema é
   whitelist: 'javascript:' num link de banner é XSS armazenado, que atinge
   todo visitante da home.

   Caractere de controle é recusado, não limpo: "java\nscript:alert(1)" passaria
   pela checagem de esquema (o \n quebra o casamento) e mesmo assim o navegador
   ignora o \n e executa. Quem envia isso não está enviando um endereço. */
const ESQUEMAS_MIDIA = ['http:', 'https:', 'data:', 'blob:'];
const ESQUEMAS_LINK = ['http:', 'https:', 'mailto:', 'tel:'];

function endereco(valor, rotulo, esquemas, { max = 500, obrigatorio = false } = {}) {
  const s = texto(valor, rotulo, { obrigatorio, max });
  if (!s) return '';

  if (/[\u0000-\u001F\u007F]/.test(s)) {
    throw erro400(`O campo "${rotulo}" contém caracteres inválidos.`);
  }

  const casou = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(s);
  /* Sem esquema é caminho relativo do próprio site ('assets/img/...'), o caso
     mais comum aqui — nada a checar. */
  if (!casou) return s;

  if (!esquemas.includes(casou[0].toLowerCase())) {
    throw erro400(`O campo "${rotulo}" só aceita endereço ${esquemas.join(', ')} ou caminho do próprio site.`);
  }
  return s;
}

/* O vídeo do banner tem uma forma a mais que as outras mídias: 'youtube:<id>'.
   É como o admin guarda um vídeo hospedado no YouTube sem coluna nova no banco
   — o renderizador vê o prefixo e monta o <iframe> em vez do <video>.

   A conferência do id é estrita (11 caracteres do alfabeto do YouTube) porque
   esse valor termina dentro de um src na home: qualquer folga aqui é injeção
   de endereço na página pública. */
const YOUTUBE = /^youtube:[A-Za-z0-9_-]{11}$/;

function enderecoDeVideo(valor, rotulo, opcoes) {
  const s = valor === null || valor === undefined ? '' : String(valor).trim();

  if (s.slice(0, 8).toLowerCase() === 'youtube:') {
    if (!YOUTUBE.test(s)) {
      throw erro400(`O campo "${rotulo}" com vídeo do YouTube precisa ser "youtube:" seguido do identificador de 11 caracteres.`);
    }
    return s;
  }

  return endereco(valor, rotulo, ESQUEMAS_MIDIA, opcoes);
}

/* --------------------------------------------------------------------------
   IDENTIFICADORES

   Mesmo formato que o protótipo gerava ('p'+Date.now(), 's'+Date.now()…) para
   que um banco semeado e um registro criado pela API sejam indistinguíveis.
   -------------------------------------------------------------------------- */

function idLivre(tabela, candidato) {
  let id = candidato;
  let n = 2;
  while (db.um(`SELECT 1 FROM ${tabela} WHERE id = ?`, id)) {
    id = `${candidato}-${n}`;
    n++;
  }
  return id;
}

function novoId(recurso, corpo) {
  const informadoPeloCliente = texto(corpo.id, 'Identificador', { max: 60 });
  if (!informadoPeloCliente) return idLivre(recurso.tabela, recurso.gerarId(corpo));

  /* O id vira segmento de URL em /api/…/:id. Barra, espaço ou acento ali
     tornariam o registro inalcançável pela própria API que o criou. */
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(informadoPeloCliente)) {
    throw erro400('O identificador aceita apenas letras, números, ponto, hífen e sublinhado.');
  }
  if (db.um(`SELECT 1 FROM ${recurso.tabela} WHERE id = ?`, informadoPeloCliente)) {
    throw erro409(`Já existe um registro com o identificador "${informadoPeloCliente}".`);
  }
  return informadoPeloCliente;
}

/** Slug sem acento nem símbolo — é o id que blog-categorias.html monta. */
function slug(nome) {
  return String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'item';
}

/* --------------------------------------------------------------------------
   ESCRITA GENÉRICA

   Nome de tabela e de coluna sempre vêm das constantes deste arquivo e do
   objeto montado por mapa.paraLinha*; valor nenhum é interpolado no SQL.
   -------------------------------------------------------------------------- */

function inserirLinha(tabela, linha) {
  const colunas = Object.keys(linha);
  db.executar(
    `INSERT INTO ${tabela} (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );
}

function atualizarLinha(tabela, linha, id) {
  /* O id vem na cláusula WHERE; deixá-lo também no SET só arriscaria trocar a
     chave primária por engano. */
  const colunas = Object.keys(linha).filter((c) => c !== 'id');
  db.executar(
    `UPDATE ${tabela} SET ${colunas.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
    ...colunas.map((c) => linha[c]), id
  );
}

/** Próxima posição livre de uma lista ordenada. */
function proximaOrdem(tabela) {
  return (db.valor(`SELECT MAX(ordem) FROM ${tabela} WHERE arquivado_em IS NULL`) || 0) + 1;
}

function buscar(recurso, id) {
  const linha = db.um(`SELECT * FROM ${recurso.tabela} WHERE id = ?`, id);
  if (!linha) throw erro404(`${recurso.rotulo} não encontrado(a): ${id}.`);
  return linha;
}

/* --------------------------------------------------------------------------
   VALIDADORES POR RECURSO

   Cada um recebe o corpo cru e devolve só os campos que vieram, já
   normalizados. Campo ausente é campo não alterado: é o que permite ao PUT
   mesclar com o registro atual sem apagar o que a tela não enviou.
   -------------------------------------------------------------------------- */

const MODALIDADES = Object.keys(regras.MODALIDADES);

function validarPost(corpo, { novo }) {
  const d = {};

  if (novo || informado(corpo, 'titulo')) {
    d.titulo = texto(corpo.titulo, 'Título', { obrigatorio: true, max: 200 });
  }
  if (informado(corpo, 'cat')) d.cat = categoriaValida(corpo.cat);
  if (informado(corpo, 'data')) d.data = dataISO(corpo.data, 'Data') || null;
  if (informado(corpo, 'autor')) d.autor = texto(corpo.autor, 'Autor', { max: 120 });
  if (informado(corpo, 'img')) d.img = endereco(corpo.img, 'Imagem', ESQUEMAS_MIDIA, { max: 1500000 });
  if (informado(corpo, 'resumo')) d.resumo = texto(corpo.resumo, 'Resumo', { max: 600 });
  if (informado(corpo, 'corpo')) d.corpo = texto(corpo.corpo, 'Corpo', { max: 200000 });

  /* A tela grava `rascunho`, a API aceita os dois nomes. Como mapa.post sempre
     devolve `rascunho`, o valor atual venceria a mesclagem do PUT se só
     `publicado` viesse no corpo — daí normalizar um a partir do outro aqui. */
  if (informado(corpo, 'rascunho')) {
    d.rascunho = booleano(corpo.rascunho);
    d.publicado = !d.rascunho;
  } else if (informado(corpo, 'publicado')) {
    d.publicado = booleano(corpo.publicado);
    d.rascunho = !d.publicado;
  }

  return d;
}

/**
 * `cat` guarda o NOME da categoria (convenção do protótipo). Aceitamos id ou
 * nome e gravamos sempre o nome, para o blog não acabar com as duas formas
 * misturadas e um filtro deixando publicação de fora.
 */
function categoriaValida(valor) {
  const s = texto(valor, 'Categoria', { max: 120 });
  if (!s) return '';

  const achada = db.um(
    'SELECT nome FROM categorias WHERE arquivado_em IS NULL AND (id = ? OR lower(nome) = lower(?))',
    s, s
  );
  if (!achada) throw erro400(`A categoria "${s}" não existe. Cadastre-a antes de usar.`);
  return achada.nome;
}

function validarCategoria(corpo, { novo, atual }) {
  const d = {};

  if (novo || informado(corpo, 'nome')) {
    d.nome = texto(corpo.nome, 'Nome', { obrigatorio: true, max: 120 });

    /* Dois nomes iguais quebram a busca do front-end, que casa post e categoria
       pelo nome — passaria a existir mais de uma categoria candidata. */
    const repetida = db.um(
      `SELECT id FROM categorias
        WHERE arquivado_em IS NULL AND lower(nome) = lower(?) AND id <> ?`,
      d.nome, atual ? atual.id : ''
    );
    if (repetida) throw erro409(`Já existe a categoria "${d.nome}".`);
  }
  if (informado(corpo, 'descricao')) d.descricao = texto(corpo.descricao, 'Descrição', { max: 600 });
  if (informado(corpo, 'cor')) d.cor = cor(corpo.cor, 'Cor');

  return d;
}

function validarEvento(corpo, { novo }) {
  const d = {};

  if (novo || informado(corpo, 'titulo')) {
    d.titulo = texto(corpo.titulo, 'Título', { obrigatorio: true, max: 200 });
  }
  if (informado(corpo, 'mod')) {
    const m = texto(corpo.mod, 'Modalidade', { max: 40 });
    if (m && !MODALIDADES.includes(m)) {
      throw erro400(`Modalidade desconhecida: "${m}". Use uma de: ${MODALIDADES.join(', ')}.`);
    }
    d.mod = m;
  }
  if (informado(corpo, 'ano')) {
    d.ano = inteiro(corpo.ano, 'Ano', { min: 1900, max: new Date().getFullYear() + 10, padrao: null });
  }
  if (informado(corpo, 'local')) d.local = texto(corpo.local, 'Local', { max: 160 });
  if (informado(corpo, 'fotos')) d.fotos = inteiro(corpo.fotos, 'Fotos', { min: 0, max: 100000, padrao: 0 });

  return d;
}

function validarParceiro(corpo, { novo }) {
  const d = {};

  if (novo || informado(corpo, 'nome')) {
    d.nome = texto(corpo.nome, 'Nome', { obrigatorio: true, max: 160 });
  }
  if (informado(corpo, 'tipo')) d.tipo = texto(corpo.tipo, 'Tipo', { max: 120 });
  if (informado(corpo, 'logo')) d.logo = endereco(corpo.logo, 'Logo', ESQUEMAS_MIDIA, { max: 1500000 });
  if (informado(corpo, 'ordem')) d.ordem = inteiro(corpo.ordem, 'Ordem', { min: 0, max: 9999, padrao: 0 });

  /* A home escolhe o logo pelo índice da lista: parceiro sem ordem entraria na
     frente de todos e trocaria a marca de cada posição. */
  if (novo && d.ordem === undefined) d.ordem = proximaOrdem('parceiros');

  return d;
}

function validarBanner(corpo, { novo }) {
  const d = {};

  if (informado(corpo, 'titulo')) d.titulo = texto(corpo.titulo, 'Título', { max: 200 });
  if (novo || informado(corpo, 'img')) {
    d.img = endereco(corpo.img, 'Imagem', ESQUEMAS_MIDIA, { max: 1500000, obrigatorio: true });
  }
  if (informado(corpo, 'link')) d.link = endereco(corpo.link, 'Link', ESQUEMAS_LINK);
  if (informado(corpo, 'ordem')) d.ordem = inteiro(corpo.ordem, 'Ordem', { min: 0, max: 9999, padrao: 0 });
  if (informado(corpo, 'ativo')) d.ativo = booleano(corpo.ativo);

  if (novo && d.ordem === undefined) d.ordem = proximaOrdem('banners');

  return d;
}

function validarBannerSite(corpo, { novo, atual }) {
  const d = {};

  if (informado(corpo, 'midia')) {
    const m = texto(corpo.midia, 'Mídia', { max: 10 }).toLowerCase();
    if (m && m !== 'imagem' && m !== 'video') {
      throw erro400('O campo "Mídia" aceita apenas "imagem" ou "video".');
    }
    d.midia = m || 'imagem';
  }
  if (informado(corpo, 'img')) d.img = endereco(corpo.img, 'Imagem', ESQUEMAS_MIDIA, { max: 1500000 });
  if (informado(corpo, 'video')) d.video = enderecoDeVideo(corpo.video, 'Vídeo', { max: 1500000 });
  if (informado(corpo, 'texto')) d.texto = texto(corpo.texto, 'Texto', { max: 1200 });
  if (informado(corpo, 'eyebrow')) d.eyebrow = texto(corpo.eyebrow, 'Etiqueta', { max: 80 });
  if (informado(corpo, 'botao')) d.botao = texto(corpo.botao, 'Botão', { max: 60 });
  if (informado(corpo, 'botao2')) d.botao2 = texto(corpo.botao2, 'Botão secundário', { max: 60 });
  if (informado(corpo, 'link')) d.link = endereco(corpo.link, 'Link', ESQUEMAS_LINK);
  if (informado(corpo, 'link2')) d.link2 = endereco(corpo.link2, 'Link secundário', ESQUEMAS_LINK);
  if (informado(corpo, 'tituloTamanho')) {
    d.tituloTamanho = inteiro(corpo.tituloTamanho, 'Tamanho do título', { min: 0, max: 200, padrao: 0 });
  }
  if (informado(corpo, 'semTexto')) d.semTexto = booleano(corpo.semTexto);
  if (informado(corpo, 'ativo')) d.ativo = booleano(corpo.ativo);
  if (informado(corpo, 'titulo')) d.titulo = texto(corpo.titulo, 'Título', { max: 200 });
  /* admin/banners-site.html tira e devolve o banner à rotação gravando este
     campo no próprio objeto, em vez de usar DELETE. Sem deixá-lo passar por
     aqui, "Remover da rotação" e "Restaurar" respondiam 200 sem efeito. */
  if (informado(corpo, 'arquivado')) d.arquivado = booleano(corpo.arquivado);

  /* Estado final = o que já existe + o que veio agora. As checagens cruzadas
     abaixo dependem dele: um PUT que só troca a mídia precisa ser barrado se o
     arquivo correspondente nunca foi enviado. */
  const alvo = Object.assign({}, atual ? mapa.bannerSite(atual) : {}, d);

  if (alvo.midia === 'video') {
    if (!alvo.video) throw erro400('Banner de vídeo precisa do endereço do vídeo.');
  } else if (!alvo.img) {
    throw erro400('Banner de imagem precisa da imagem.');
  }

  /* Hero sem texto é decisão explícita (semTexto). Fora disso, um slide sem
     título entra no ar em branco. */
  if (!alvo.semTexto && !texto(alvo.titulo, 'Título', { max: 200 })) {
    throw erro400('Informe o título do banner ou marque "sem texto".');
  }

  if (novo && !informado(corpo, 'ordem')) {
    d.ordem = proximaOrdem('banners_site');
  } else if (informado(corpo, 'ordem')) {
    d.ordem = inteiro(corpo.ordem, 'Ordem', { min: 0, max: 9999, padrao: 0 });
    exigirOrdemLivre(d.ordem, atual ? atual.id : '');
  }

  return d;
}

/**
 * Duas peças do hero na mesma posição deixam a ordem do slider dependente do
 * id, que o operador não controla. Então a posição continua sendo única — mas
 * pedir uma posição ocupada TROCA os dois de lugar em vez de ser recusado.
 *
 * Recusar quebrava as setas ▲▼ de admin/banners-site.html, que expressam a
 * troca como dois PUT sequenciais: o primeiro sempre colidia com o vizinho e
 * derrubava a operação inteira. Com a troca, o primeiro PUT já deixa a lista
 * correta e o segundo vira repetição inofensiva.
 *
 * Roda dentro da transação de quem chama, então nunca fica um estado com dois
 * banners na mesma posição.
 */
function exigirOrdemLivre(ordem, idAtual) {
  const ocupante = db.um(
    `SELECT id, ordem FROM banners_site
      WHERE ordem = ? AND arquivado_em IS NULL AND id <> ?`,
    ordem, idAtual || ''
  );
  if (!ocupante) return;

  const meu = idAtual
    ? db.um('SELECT ordem FROM banners_site WHERE id = ?', idAtual)
    : null;

  /* Banner novo não tem posição anterior para ceder: empurra o ocupante para o
     fim, que é o único destino que não colide com mais ninguém. */
  const destino = meu ? meu.ordem : proximaOrdem('banners_site');

  db.executar('UPDATE banners_site SET ordem = ? WHERE id = ?', destino, ocupante.id);
}

/* --------------------------------------------------------------------------
   LINHAS QUE mapa.js NÃO MONTA

   mapa.js expõe evento() e parceiro() só na leitura — não há paraLinhaEvento
   nem paraLinhaParceiro. As duas tabelas são simples e sem conversão de tipo,
   então a inversa fica aqui em vez de alterar mapa.js.
   -------------------------------------------------------------------------- */

function paraLinhaEvento(e, { id } = {}) {
  return db.limpar({
    id: id || e.id,
    titulo: e.titulo,
    mod: e.mod || null,
    ano: e.ano === undefined || e.ano === null || e.ano === '' ? null : Number(e.ano),
    local: e.local || null,
    fotos: Number(e.fotos) || 0
  });
}

function paraLinhaParceiro(p, { id } = {}) {
  return db.limpar({
    id: id || p.id,
    nome: p.nome,
    tipo: p.tipo || null,
    /* O protótipo desenha o logo a partir da ordem quando não há arquivo. */
    logo: p.logo || null,
    ordem: Number(p.ordem) || 0
  });
}

/* --------------------------------------------------------------------------
   DESCRIÇÃO DOS RECURSOS
   -------------------------------------------------------------------------- */

const RECURSOS = [
  {
    caminho: '/api/posts',
    tabela: 'posts',
    chave: 'posts',
    chaveUm: 'post',
    rotulo: 'Publicação',
    area: 'blog',                       /* área da auditoria, como no front-end */
    permissao: 'blog:escrever',
    ler: mapa.post,
    paraLinha: mapa.paraLinhaPost,
    validar: validarPost,
    gerarId: () => `p${Date.now()}`,
    nomeDe: (item) => item.titulo,
    ordenacao: 'data DESC, id',
    /* Rascunho é material do CMS: o site público recebe só o que foi publicado. */
    filtroPublico: 'publicado = 1',
    filtros(ctx) {
      const partes = [];
      const params = [];
      const cat = (ctx.query.get('cat') || '').trim();
      if (cat) {
        /* post.cat guarda o NOME da categoria, mas a URL do blog costuma trazer
           o slug: as duas formas chegam aqui. A comparação direta pelo nome vem
           antes da tradução pelo id para o filtro continuar valendo mesmo que a
           categoria tenha sido arquivada. */
        partes.push('(lower(cat) = lower(?) OR cat IN (SELECT nome FROM categorias WHERE id = ?))');
        params.push(cat, cat);
      }
      return { partes, params };
    }
  },
  {
    caminho: '/api/categorias',
    tabela: 'categorias',
    chave: 'categorias',
    chaveUm: 'categoria',
    rotulo: 'Categoria',
    area: 'blog',
    permissao: 'blog:escrever',
    ler: mapa.categoria,
    paraLinha: mapa.paraLinhaCategoria,
    validar: validarCategoria,
    gerarId: (corpo) => slug(corpo.nome),
    nomeDe: (item) => item.nome,
    ordenacao: 'nome',
    antesDeArquivar: exigirCategoriaSemPost
  },
  {
    caminho: '/api/eventos',
    tabela: 'eventos',
    chave: 'eventos',
    chaveUm: 'evento',
    rotulo: 'Evento',
    area: 'configuracao',
    permissao: 'conteudo:escrever',
    ler: mapa.evento,
    paraLinha: paraLinhaEvento,
    validar: validarEvento,
    gerarId: () => `e${Date.now()}`,
    nomeDe: (item) => item.titulo,
    ordenacao: 'ano DESC, id'
  },
  {
    caminho: '/api/parceiros',
    tabela: 'parceiros',
    chave: 'parceiros',
    chaveUm: 'parceiro',
    rotulo: 'Parceiro',
    area: 'configuracao',
    permissao: 'conteudo:escrever',
    ler: mapa.parceiro,
    paraLinha: paraLinhaParceiro,
    validar: validarParceiro,
    gerarId: () => `pa${Date.now()}`,
    nomeDe: (item) => item.nome,
    ordenacao: 'ordem, id'
  },
  {
    caminho: '/api/banners',
    tabela: 'banners',
    chave: 'banners',
    chaveUm: 'banner',
    rotulo: 'Banner',
    area: 'configuracao',
    permissao: 'banners:escrever',
    ler: mapa.banner,
    paraLinha: mapa.paraLinhaBanner,
    validar: validarBanner,
    gerarId: () => `b${Date.now()}`,
    nomeDe: (item) => item.titulo || item.id,
    ordenacao: 'ordem, id',
    filtroPublico: 'ativo = 1'
  },
  {
    caminho: '/api/banners-site',
    tabela: 'banners_site',
    chave: 'bannersSite',
    chaveUm: 'bannerSite',
    rotulo: 'Banner do site',
    area: 'configuracao',
    permissao: 'banners:escrever',
    ler: mapa.bannerSite,
    paraLinha: mapa.paraLinhaBannerSite,
    validar: validarBannerSite,
    gerarId: () => `s${Date.now()}`,
    nomeDe: (item) => item.titulo || item.id,
    ordenacao: 'ordem, id',
    filtroPublico: 'ativo = 1'
  }
];

/** Categoria em uso é referência viva do blog: apagar deixaria post órfão. */
function exigirCategoriaSemPost(ctx, linha) {
  const emUso = db.todos(
    `SELECT titulo FROM posts
      WHERE arquivado_em IS NULL AND (cat = ? OR cat = ?)
      ORDER BY data DESC LIMIT 5`,
    linha.nome, linha.id
  );
  if (!emUso.length) return;

  const total = db.valor(
    'SELECT COUNT(*) FROM posts WHERE arquivado_em IS NULL AND (cat = ? OR cat = ?)',
    linha.nome, linha.id
  );

  throw erro409(
    `A categoria "${linha.nome}" está em ${total} publicação(ões) e não pode ir para o histórico. ` +
    'Mude a categoria dessas publicações ou arquive-as antes.',
    { posts: total, exemplos: emUso.map((p) => p.titulo) }
  );
}

/* --------------------------------------------------------------------------
   LEITURA
   -------------------------------------------------------------------------- */

/**
 * Monta o WHERE conforme quem pergunta.
 *   sem sessão / competidor → só o que está no ar
 *   admin com ?tudo=1       → soma rascunho e inativo
 *   admin com ?arquivados=1 → só o histórico
 */
function condicoes(recurso, ctx) {
  const arquivados = ctx.query.get('arquivados') === '1';
  const tudo = ctx.query.get('tudo') === '1';

  /* Conteúdo fora do ar é material interno: exige sessão de administrador —
     qualquer nível, porque é leitura. */
  if (arquivados || tudo) ctx.exigirAdmin();

  const partes = [arquivados ? 'arquivado_em IS NOT NULL' : 'arquivado_em IS NULL'];
  const params = [];

  if (!arquivados && !tudo && recurso.filtroPublico) partes.push(recurso.filtroPublico);

  if (recurso.filtros) {
    const extra = recurso.filtros(ctx);
    partes.push(...extra.partes);
    params.push(...extra.params);
  }

  return { partes, params, arquivados };
}

function listar(recurso, ctx) {
  const { partes, params, arquivados } = condicoes(recurso, ctx);

  const limite = ctx.query.get('limite')
    ? inteiro(ctx.query.get('limite'), 'Limite', { min: 1, max: LIMITE_MAX })
    : LIMITE_PADRAO;

  /* No histórico interessa o que saiu do ar por último, não a ordem editorial. */
  const ordem = arquivados ? 'arquivado_em DESC, id' : recurso.ordenacao;

  const linhas = db.todos(
    `SELECT * FROM ${recurso.tabela}
      WHERE ${partes.join(' AND ')}
      ORDER BY ${ordem}
      LIMIT ?`,
    ...params, limite
  );

  const total = db.valor(
    `SELECT COUNT(*) FROM ${recurso.tabela} WHERE ${partes.join(' AND ')}`, ...params
  );

  /* Tradução aplicada na linha crua, antes de recurso.ler: o mapeamento de
     cada tabela continua sem saber que idioma existe. */
  return ctx.ok({
    ok: true,
    [recurso.chave]: mapa.lista(ctx.traduzir(recurso.tabela, linhas), recurso.ler),
    total,
    limite
  });
}

function ler(recurso, ctx) {
  const linha = buscar(recurso, ctx.params.id);

  /* Rascunho, banner inativo e item arquivado só aparecem para administrador —
     senão bastaria adivinhar o id para ler o que ainda não foi publicado. */
  const noAr = !linha.arquivado_em
    && (!recurso.filtroPublico || db.um(
      `SELECT 1 FROM ${recurso.tabela} WHERE id = ? AND ${recurso.filtroPublico}`, linha.id
    ));
  if (!noAr) ctx.exigirAdmin();

  return ctx.ok({ ok: true, [recurso.chaveUm]: recurso.ler(ctx.traduzir(recurso.tabela, linha)) });
}

/* --------------------------------------------------------------------------
   ESCRITA
   -------------------------------------------------------------------------- */

async function criar(recurso, ctx) {
  ctx.exigirAdmin(recurso.permissao);
  const corpo = await ctx.corpo();

  /* Validar, gravar e auditar numa transação só: um erro no meio não deixa
     registro pela metade nem trilha de auditoria de algo que não aconteceu. */
  const item = db.transacao(() => {
    const dados = recurso.validar(corpo, { novo: true, atual: null });
    const id = novoId(recurso, corpo);

    /* O id vai nos dados E na opção: mapa.paraLinhaCategoria é a única inversa
       que não recebe { id } e lê o campo direto do objeto. Sem isto a categoria
       nova entraria com id nulo — o SQLite aceita nulo em PRIMARY KEY de texto
       e a linha ficaria inalcançável. */
    const linha = recurso.paraLinha(Object.assign({}, dados, { id }), { id });
    inserirLinha(recurso.tabela, linha);

    const salvo = recurso.ler(db.um(`SELECT * FROM ${recurso.tabela} WHERE id = ?`, id));
    regras.registrar(ctx, recurso.area, recurso.nomeDe(salvo), `criou ${recurso.rotulo.toLowerCase()}`, id);
    return salvo;
  });

  return ctx.ok({ ok: true, [recurso.chaveUm]: item });
}

async function atualizar(recurso, ctx) {
  ctx.exigirAdmin(recurso.permissao);
  const corpo = await ctx.corpo();

  const item = db.transacao(() => {
    const atual = buscar(recurso, ctx.params.id);
    const dados = recurso.validar(corpo, { novo: false, atual });

    /* mapa.paraLinha* devolve a linha COMPLETA: sem mesclar com o que já
       existe, todo campo que a tela não enviou seria apagado. */
    const mesclado = Object.assign({}, recurso.ler(atual), dados);
    const linha = recurso.paraLinha(mesclado, { id: atual.id, criadoEm: atual.criado_em });
    atualizarLinha(recurso.tabela, linha, atual.id);

    const salvo = recurso.ler(db.um(`SELECT * FROM ${recurso.tabela} WHERE id = ?`, atual.id));
    regras.registrar(ctx, recurso.area, recurso.nomeDe(salvo), `atualizou ${recurso.rotulo.toLowerCase()}`, atual.id);
    return salvo;
  });

  return ctx.ok({ ok: true, [recurso.chaveUm]: item });
}

/** DELETE é arquivamento: o registro sai de circulação e fica no histórico. */
async function arquivar(recurso, ctx) {
  ctx.exigirAdmin(recurso.permissao);

  const item = db.transacao(() => {
    const linha = buscar(recurso, ctx.params.id);
    if (linha.arquivado_em) throw erro409(`${recurso.rotulo} já está no histórico.`);

    if (recurso.antesDeArquivar) recurso.antesDeArquivar(ctx, linha);

    db.executar(`UPDATE ${recurso.tabela} SET arquivado_em = ? WHERE id = ?`, db.agora(), linha.id);

    const salvo = recurso.ler(db.um(`SELECT * FROM ${recurso.tabela} WHERE id = ?`, linha.id));
    regras.registrar(ctx, recurso.area, recurso.nomeDe(salvo), `arquivou ${recurso.rotulo.toLowerCase()}`, linha.id);
    return salvo;
  });

  return ctx.ok({ ok: true, [recurso.chaveUm]: item });
}

/* --------------------------------------------------------------------------
   REORDENAÇÃO DO HERO

   Trocar duas posições direto no campo `ordem` passa por um estado em que as
   duas colidem. Aqui a lista inteira é renumerada de 1 a N numa transação, o
   que mantém a posição única o tempo todo.
   -------------------------------------------------------------------------- */

async function reordenarBannerSite(ctx) {
  const recurso = RECURSOS.find((r) => r.tabela === 'banners_site');
  ctx.exigirAdmin(recurso.permissao);
  const corpo = await ctx.corpo();

  const lista = db.transacao(() => {
    const alvo = buscar(recurso, ctx.params.id);
    if (alvo.arquivado_em) throw erro409('Banner no histórico não entra na ordem do hero.');

    const ativos = db.todos(
      'SELECT id FROM banners_site WHERE arquivado_em IS NULL ORDER BY ordem, id'
    ).map((l) => l.id);

    /* Posição é 1-based (é o que o operador vê na tela) e presa ao tamanho da
       lista: pedir a 99ª de três banners significa "manda para o fim". */
    const destino = Math.min(
      Math.max(inteiro(corpo.ordem, 'Ordem', { min: 1, max: 9999 }), 1),
      ativos.length
    );

    const sem = ativos.filter((id) => id !== alvo.id);
    sem.splice(destino - 1, 0, alvo.id);
    sem.forEach((id, i) => db.executar('UPDATE banners_site SET ordem = ? WHERE id = ?', i + 1, id));

    regras.registrar(ctx, recurso.area, alvo.titulo || alvo.id, 'reordenou banner do site', `posição ${destino}`);

    return db.todos('SELECT * FROM banners_site WHERE arquivado_em IS NULL ORDER BY ordem, id');
  });

  return ctx.ok({ ok: true, bannersSite: mapa.lista(lista, mapa.bannerSite) });
}

/* --------------------------------------------------------------------------
   REGISTRO DAS ROTAS
   -------------------------------------------------------------------------- */

function registrarCrud(rotas, recurso) {
  rotas.get(recurso.caminho, async (ctx) => listar(recurso, ctx));
  rotas.get(`${recurso.caminho}/:id`, async (ctx) => ler(recurso, ctx));
  rotas.post(recurso.caminho, (ctx) => criar(recurso, ctx));
  rotas.put(`${recurso.caminho}/:id`, (ctx) => atualizar(recurso, ctx));
  /* PATCH cai no mesmo handler: a atualização já é parcial por natureza — o
     que não vem no corpo é mesclado a partir do registro atual. */
  rotas.patch(`${recurso.caminho}/:id`, (ctx) => atualizar(recurso, ctx));
  rotas.delete(`${recurso.caminho}/:id`, (ctx) => arquivar(recurso, ctx));
}

function registrar(rotas) {
  RECURSOS.forEach((recurso) => registrarCrud(rotas, recurso));
  rotas.post('/api/banners-site/:id/ordem', (ctx) => reordenarBannerSite(ctx));
}

module.exports = { registrar, RECURSOS };
