/* ==========================================================================
   PHYGITAL BRASIL — TRADUÇÃO DO CONTEÚDO CADASTRADO (ADMIN)

   O cliente pediu o conteúdo traduzido, não só a interface. Estas rotas são a
   porta pela qual o administrador escreve inglês e espanhol para um registro
   que já existe em português.

     GET /api/traducoes/campos                  o que é traduzível, por tabela
     GET /api/traducoes?tabela=&registro=       o que já foi traduzido
     PUT /api/traducoes                         grava (texto vazio apaga)

   Duas coisas que valem explicar:

   · O português NÃO entra aqui. Ele mora na coluna da tabela de negócio e é
     editado pela tela normal de cadastro; gravá-lo também em `traducoes` criaria
     duas verdades para o mesmo campo. Pedir idioma 'pt' devolve 400.
   · A permissão é a de ESCRITA da área do registro. Traduzir o nome de um
     campeonato é escrever no campeonato, ainda que em outra coluna — quem não
     pode editar campeonato não pode reescrevê-lo em inglês.
   ========================================================================== */
'use strict';

const db = require('../db');
const regras = require('../regras');
const traducoes = require('../traducoes');
const { erro400, erro404 } = require('../http');

/* --------------------------------------------------------------------------
   ÁREA E PERMISSÃO POR TABELA

   Espelha as permissões que as rotas de cada área já exigem (conteudo.js,
   campeonatos.js, email.js). `area` é o rótulo da trilha de auditoria, o mesmo
   que aquelas rotas usam.
   -------------------------------------------------------------------------- */

const AREAS = {
  campeonatos:   { permissao: 'campeonatos:editar', area: 'campeonato', rotulo: 'campeonato' },
  posts:         { permissao: 'blog:escrever',      area: 'blog',       rotulo: 'publicação' },
  categorias:    { permissao: 'blog:escrever',      area: 'blog',       rotulo: 'categoria' },
  eventos:       { permissao: 'conteudo:escrever',  area: 'configuracao', rotulo: 'evento' },
  parceiros:     { permissao: 'conteudo:escrever',  area: 'configuracao', rotulo: 'parceiro' },
  banners:       { permissao: 'banners:escrever',   area: 'configuracao', rotulo: 'banner' },
  banners_site:  { permissao: 'banners:escrever',   area: 'configuracao', rotulo: 'banner do site' },
  modelos_email: { permissao: 'email:configurar',   area: 'email',       rotulo: 'modelo de e-mail' }
};

/* Guarda de manutenção: uma tabela nova em CAMPOS_TRADUZIVEIS sem entrada aqui
   ficaria sem dono de permissão, e o erro só apareceria em produção. */
for (const tabela of traducoes.TABELAS_TRADUZIVEIS) {
  if (!AREAS[tabela]) {
    throw new Error(`Tabela traduzível sem permissão definida em rotas/traducoes.js: ${tabela}`);
  }
}

/* --------------------------------------------------------------------------
   VALIDAÇÃO DA ENTRADA

   Tudo aqui vira nome de tabela numa consulta. Nada é interpolado sem antes
   passar por esta lista fechada — é o que impede que o parâmetro vire SQL.
   -------------------------------------------------------------------------- */

function exigirTabela(valor) {
  const tabela = String(valor || '').trim();
  if (!AREAS[tabela]) {
    throw erro400(
      `Tabela sem tradução: "${tabela || '(vazio)'}". `
      + `Use uma destas: ${traducoes.TABELAS_TRADUZIVEIS.join(', ')}.`
    );
  }
  return tabela;
}

function exigirRegistro(tabela, valor) {
  const id = String(valor || '').trim();
  if (!id) throw erro400('Informe o registro (registro).');

  /* O nome da tabela veio de AREAS, nunca do corpo da requisição. */
  const existe = db.um(`SELECT id FROM ${tabela} WHERE id = ?`, id);
  if (!existe) throw erro404(`Registro não encontrado em ${tabela}: ${id}.`);
  return id;
}

function exigirIdioma(valor) {
  const idioma = traducoes.normalizar(valor);
  if (!idioma) {
    throw erro400(`Idioma inválido: "${valor}". Use ${traducoes.IDIOMAS_TRADUZIVEIS.join(' ou ')}.`);
  }
  if (idioma === traducoes.IDIOMA_PADRAO) {
    throw erro400(
      'O português é a língua de origem e é editado na própria tela de cadastro, '
      + 'não aqui.'
    );
  }
  return idioma;
}

function exigirCampo(tabela, valor) {
  const campo = String(valor || '').trim();
  const campos = traducoes.CAMPOS_TRADUZIVEIS[tabela];
  if (!campos.includes(campo)) {
    throw erro400(
      `Campo não traduzível em ${tabela}: "${campo || '(vazio)'}". `
      + `Use um destes: ${campos.join(', ')}.`
    );
  }
  return campo;
}

/* --------------------------------------------------------------------------
   LEITURA
   -------------------------------------------------------------------------- */

/**
 * O que a tela do admin precisa para se montar sozinha: as tabelas, os campos
 * de cada uma e os idiomas. Constante única — a mesma que a leitura do
 * conteúdo usa, então tela e servidor nunca divergem.
 */
async function campos(ctx) {
  ctx.exigirAdmin();

  ctx.ok({
    ok: true,
    idiomas: traducoes.IDIOMAS,
    idiomaPadrao: traducoes.IDIOMA_PADRAO,
    idiomasTraduziveis: traducoes.IDIOMAS_TRADUZIVEIS,
    campos: traducoes.CAMPOS_TRADUZIVEIS,
    /* Para a tela esconder o que este administrador não pode editar. */
    permissoes: Object.fromEntries(
      Object.entries(AREAS).map(([tabela, a]) => [tabela, a.permissao])
    ),
    /* Quanto já existe, por tabela e idioma: é o que deixa a tela mostrar o que
       falta traduzir sem varrer registro por registro. */
    resumo: traducoes.resumo()
  });
}

async function listar(ctx) {
  /* Barra o anônimo antes de qualquer validação de entrada: sem isto, quem não
     tem sessão descobriria pelo texto do 400 o que existe do outro lado. */
  ctx.exigirAdmin();

  const tabela = exigirTabela(ctx.query.get('tabela'));
  ctx.exigirAdmin(AREAS[tabela].permissao);
  const registro = exigirRegistro(tabela, ctx.query.get('registro'));

  const original = db.um(`SELECT * FROM ${tabela} WHERE id = ?`, registro);
  const campoALista = traducoes.CAMPOS_TRADUZIVEIS[tabela];

  ctx.ok({
    ok: true,
    tabela,
    registro,
    campos: campoALista,
    /* O português ao lado, para o tradutor ver o que está traduzindo sem
       precisar abrir a tela de cadastro em outra aba. */
    original: Object.fromEntries(campoALista.map((c) => [c, original[c] || ''])),
    traducoes: traducoes.mapaDe(tabela, registro)
  });
}

/* --------------------------------------------------------------------------
   ESCRITA
   -------------------------------------------------------------------------- */

/**
 * Aceita as duas formas, porque a tela grava o formulário inteiro e o teste (ou
 * um ajuste pontual) grava um campo só:
 *
 *   { tabela, registro, traducoes: { en: { nome: '...' }, es: { ... } } }
 *   { tabela, registro, idioma: 'en', campo: 'nome', texto: '...' }
 *
 * Tudo numa transação: um campo recusado no meio não deixa metade gravada.
 */
async function salvar(ctx) {
  ctx.exigirAdmin();
  const corpo = await ctx.corpo();

  const tabela = exigirTabela(corpo.tabela);
  ctx.exigirAdmin(AREAS[tabela].permissao);
  const registro = exigirRegistro(tabela, corpo.registro);

  /* Normaliza as duas formas de entrada numa lista só antes de tocar no banco. */
  const pedidos = [];

  if (corpo.campo !== undefined || corpo.idioma !== undefined) {
    pedidos.push({
      idioma: exigirIdioma(corpo.idioma),
      campo: exigirCampo(tabela, corpo.campo),
      texto: corpo.texto
    });
  }

  const porIdioma = corpo.traducoes;
  if (porIdioma !== undefined) {
    if (porIdioma === null || typeof porIdioma !== 'object' || Array.isArray(porIdioma)) {
      throw erro400('"traducoes" deve ser um objeto no formato { en: { campo: texto } }.');
    }
    for (const [idiomaBruto, valores] of Object.entries(porIdioma)) {
      const idioma = exigirIdioma(idiomaBruto);
      if (valores === null || typeof valores !== 'object' || Array.isArray(valores)) {
        throw erro400(`"traducoes.${idiomaBruto}" deve ser um objeto { campo: texto }.`);
      }
      for (const [campoBruto, texto] of Object.entries(valores)) {
        pedidos.push({ idioma, campo: exigirCampo(tabela, campoBruto), texto });
      }
    }
  }

  if (!pedidos.length) {
    throw erro400('Nada a gravar. Envie "traducoes" ou o trio idioma/campo/texto.');
  }

  const resultado = db.transacao(() => {
    let gravados = 0;
    let apagados = 0;
    for (const p of pedidos) {
      const acao = traducoes.salvar(tabela, registro, p.campo, p.idioma, p.texto);
      if (acao === 'gravou') gravados += 1;
      if (acao === 'apagou') apagados += 1;
    }

    const idiomasTocados = [...new Set(pedidos.map((p) => p.idioma))].join(', ');
    regras.registrar(
      ctx, AREAS[tabela].area, registro,
      `traduziu ${AREAS[tabela].rotulo}`,
      `${idiomasTocados} · ${gravados} campo(s) gravado(s)`
        + (apagados ? ` · ${apagados} devolvido(s) ao português` : '')
    );

    return { gravados, apagados };
  });

  ctx.ok({
    ok: true,
    tabela,
    registro,
    ...resultado,
    traducoes: traducoes.mapaDe(tabela, registro)
  });
}

function registrar(rotas) {
  /* '/campos' antes de nada com parâmetro: o roteador devolve a primeira que
     casa. Aqui não há conflito, mas a ordem documenta a intenção. */
  rotas.get('/api/traducoes/campos', campos);
  rotas.get('/api/traducoes', listar);
  rotas.put('/api/traducoes', salvar);
}

module.exports = { registrar, AREAS };
