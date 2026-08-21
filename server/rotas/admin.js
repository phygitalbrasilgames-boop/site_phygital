/* ==========================================================================
   PHYGITAL BRASIL — ADMINISTRAÇÃO

   O que sobra do Painel do Administrador depois que campeonatos, inscrições,
   chamados, conteúdo e e-mail saíram para os próprios módulos:

     · números do painel inicial
     · usuários administradores (só o master mexe)
     · ranking por modalidade e as condições de cálculo
     · registro de auditoria
     · histórico (o que foi arquivado, restaurar e excluir em definitivo)

   Duas regras atravessam o arquivo inteiro:

   1. O que o master pode e os outros níveis não podem é verificado por
      exigirMaster(), de forma explícita. Dá para chegar ao mesmo resultado
      apenas deixando a permissão fora das listas de gestor e operação em
      auth.PERMISSOES, mas aí a regra passaria a depender de uma ausência —
      alguém acrescenta a permissão a um nível e a proteção some sem ninguém
      perceber.

   2. Nome de tabela e de coluna nunca vêm do pedido. O histórico opera sobre
      várias tabelas, e o único jeito seguro de fazer isso é traduzir o nome
      recebido pela lista branca TABELAS_HISTORICO e usar o valor que está
      escrita aqui — nunca a string que chegou.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const db = require('../db');
const auth = require('../auth');
const regras = require('../regras');
const mapa = require('../mapa');
const traducoes = require('../traducoes');
const correio = require('../email');
const { erro400, erro403, erro404, erro409 } = require('../http');

/* --------------------------------------------------------------------------
   CONSTANTES
   -------------------------------------------------------------------------- */

const NIVEIS = ['master', 'gestor', 'operacao'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

/* Alfabeto sem caracteres ambíguos (0/O, 1/l/I): a senha temporária é ditada
   por telefone ou copiada à mão. É a mesma escolha do gerador da tela de
   usuários, para as duas senhas terem a mesma cara. */
const SENHA_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const SENHA_TAMANHO = 12;

const AUDITORIA_LIMITE = 100;
const AUDITORIA_LIMITE_MAX = 500;
const HISTORICO_LIMITE = 200;
const HISTORICO_LIMITE_MAX = 1000;

/**
 * Lista branca do histórico: as únicas tabelas que aceitam restauração e
 * exclusão definitiva. `tabela` e `coluna` são literais deste arquivo e são o
 * que de fato entra no SQL; a chave do mapa é só o nome que o cliente informa.
 *
 * `area` é a área de auditoria do registro. Duas fogem da lista de áreas que a
 * tela de auditoria oferece no filtro ('time' e 'evento' entram como texto
 * livre): ali o nome certo vale mais que o filtro pronto, e a tela imprime a
 * área crua quando não conhece a chave.
 */
const TABELAS_HISTORICO = {
  contas:       { tabela: 'contas',       coluna: 'nome',    rotulo: 'usuário',          area: 'usuario' },
  campeonatos:  { tabela: 'campeonatos',  coluna: 'nome',    rotulo: 'campeonato',       area: 'campeonato' },
  times:        { tabela: 'times',        coluna: 'nome',    rotulo: 'time',             area: 'time' },
  chamados:     { tabela: 'chamados',     coluna: 'assunto', rotulo: 'chamado',          area: 'chamado' },
  posts:        { tabela: 'posts',        coluna: 'titulo',  rotulo: 'publicação',       area: 'blog' },
  categorias:   { tabela: 'categorias',   coluna: 'nome',    rotulo: 'categoria',        area: 'blog' },
  eventos:      { tabela: 'eventos',      coluna: 'titulo',  rotulo: 'evento',           area: 'configuracao' },
  parceiros:    { tabela: 'parceiros',    coluna: 'nome',    rotulo: 'parceiro',         area: 'configuracao' },
  banners:      { tabela: 'banners',      coluna: 'titulo',  rotulo: 'banner do painel', area: 'configuracao' },
  banners_site: { tabela: 'banners_site', coluna: 'titulo',  rotulo: 'banner do site',   area: 'configuracao' }
};

/* --------------------------------------------------------------------------
   APOIO
   -------------------------------------------------------------------------- */

/** Exige sessão de administrador master. `acao` completa a mensagem do 403. */
function exigirMaster(ctx, acao) {
  const conta = ctx.exigirAdmin();
  if (conta.nivel !== 'master') {
    throw erro403(`Apenas o administrador master pode ${acao}.`);
  }
  return conta;
}

function inteiro(valor, padrao, minimo, maximo) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n)) return padrao;
  if (minimo !== undefined && n < minimo) return minimo;
  if (maximo !== undefined && n > maximo) return maximo;
  return n;
}

/** Número que vem do corpo para uma coluna de contagem: nunca negativo. */
const contagem = (valor, atual = 0) => (
  valor === undefined || valor === null || valor === '' ? atual : inteiro(valor, atual, 0)
);

function dataFiltro(valor, campo) {
  if (!valor) return null;
  const data = String(valor).slice(0, 10);
  if (!DATA.test(data)) {
    throw erro400(`A data informada em "${campo}" deve estar no formato AAAA-MM-DD.`);
  }
  return data;
}

/** Modalidade de URL: desconhecida é 404, não cai em 'outros' como no domínio. */
function modalidadeValida(valor) {
  const id = String(valor || '').trim().toLowerCase();
  if (!Object.hasOwn(regras.MODALIDADES, id)) {
    throw erro404(
      `Modalidade desconhecida: "${id}". Use uma de: ${Object.keys(regras.MODALIDADES).join(', ')}.`
    );
  }
  return id;
}

/** Traduz o nome recebido pela lista branca. É a barreira contra injeção. */
function tabelaDoHistorico(valor) {
  const nome = String(valor || '').trim();
  if (!Object.hasOwn(TABELAS_HISTORICO, nome)) {
    throw erro400(
      `Tabela inválida: "${nome}". Use uma de: ${Object.keys(TABELAS_HISTORICO).join(', ')}.`
    );
  }
  return { nome, ...TABELAS_HISTORICO[nome] };
}

function adminAtivo(id) {
  const conta = db.um(
    "SELECT * FROM contas WHERE id = ? AND papel = 'admin' AND arquivado_em IS NULL",
    String(id || '')
  );
  if (!conta) throw erro404('Usuário administrador não encontrado.');
  return conta;
}

const contarMasters = () => db.valor(
  "SELECT COUNT(*) FROM contas WHERE papel = 'admin' AND nivel = 'master' AND arquivado_em IS NULL"
) || 0;

/* Id curto no formato TEXT que o esquema usa (a semente traz 'u1', 'u2'…). O
   sufixo aleatório evita colisão entre dois cadastros simultâneos. */
const novoId = (prefixo) => prefixo + crypto.randomUUID().slice(0, 8);

/**
 * Senha temporária do novo administrador. Repete o sorteio até passar pela
 * própria política do sistema: um sorteio sem número seria recusado no login
 * seguinte, e a senha que o master acabou de entregar não funcionaria.
 */
function senhaTemporaria() {
  for (let tentativa = 0; tentativa < 50; tentativa++) {
    let candidata = '';
    for (let i = 0; i < SENHA_TAMANHO; i++) {
      candidata += SENHA_ALFABETO[crypto.randomInt(0, SENHA_ALFABETO.length)];
    }
    if (auth.avaliarSenha(candidata).length === 0) return candidata;
  }
  throw new Error('Não foi possível sortear uma senha dentro da política de senhas.');
}

/* ==========================================================================
   MÉTRICAS DO PAINEL
   ========================================================================== */

/**
 * Números do painel inicial. Aberto a qualquer nível de administrador: é
 * leitura agregada, sem dado de nenhum competidor em particular.
 *
 * Os nomes dos campos repetem os que a tela já usa (campeonatosAbertos,
 * inscritos, oficial, espera, chamadosAbertos) e acrescentam o resto.
 */
async function metricas(ctx) {
  ctx.exigirAdmin();

  /* Uma varredura só na tabela de inscrições resolve os três totais. Inscritos
     é tudo que não foi cancelado — inclui lista oficial e lista de espera,
     igual à contagem que a tela do administrador mostra. */
  const inscricoes = db.um(
    `SELECT SUM(CASE WHEN status <> 'cancelada' THEN 1 ELSE 0 END) AS inscritos,
            SUM(CASE WHEN status =  'oficial'   THEN 1 ELSE 0 END) AS oficial,
            SUM(CASE WHEN status =  'espera'    THEN 1 ELSE 0 END) AS espera
       FROM inscricoes`
  ) || {};

  ctx.ok({
    ok: true,
    metricas: {
      campeonatos: db.valor('SELECT COUNT(*) FROM campeonatos WHERE arquivado_em IS NULL') || 0,
      campeonatosAbertos: db.valor(
        "SELECT COUNT(*) FROM campeonatos WHERE status = 'inscricoes' AND arquivado_em IS NULL"
      ) || 0,
      inscritos: inscricoes.inscritos || 0,
      oficial: inscricoes.oficial || 0,
      espera: inscricoes.espera || 0,
      times: db.valor('SELECT COUNT(*) FROM times WHERE arquivado_em IS NULL') || 0,
      /* Atleta de time arquivado não conta: o time saiu de circulação. */
      atletas: db.valor(
        `SELECT COUNT(*) FROM jogadores j
           JOIN times t ON t.id = j.time_id
          WHERE t.arquivado_em IS NULL`
      ) || 0,
      /* "Aberto" aqui é tudo que ainda não foi encerrado — aberto, em
         andamento e respondido continuam na fila de quem atende. */
      chamadosAbertos: db.valor(
        "SELECT COUNT(*) FROM chamados WHERE status <> 'encerrado' AND arquivado_em IS NULL"
      ) || 0,
      emailsEnviados: db.valor('SELECT COUNT(*) FROM emails_enviados') || 0,
      administradores: db.valor(
        "SELECT COUNT(*) FROM contas WHERE papel = 'admin' AND arquivado_em IS NULL"
      ) || 0
    }
  });
}

/* ==========================================================================
   USUÁRIOS ADMINISTRADORES
   ========================================================================== */

/**
 * Lista os administradores em circulação. Os removidos ficam em
 * GET /api/historico, de onde podem voltar.
 *
 * A saída passa por mapa.adminUsuario, que monta o objeto campo a campo — é o
 * que garante que senha_hash e senha_salt não saiam daqui. Espalhar a linha do
 * banco na resposta vazaria os dois.
 */
async function listarUsuarios(ctx) {
  exigirMaster(ctx, 'ver a lista de administradores');

  const linhas = db.todos(
    `SELECT * FROM contas
      WHERE papel = 'admin' AND arquivado_em IS NULL
      ORDER BY criado_em, id`
  );

  ctx.ok({ ok: true, total: linhas.length, usuarios: mapa.lista(linhas, mapa.adminUsuario) });
}

async function criarUsuario(ctx) {
  exigirMaster(ctx, 'cadastrar administradores');
  const corpo = await ctx.corpo();

  const nome = String(corpo.nome || '').trim();
  const email = String(corpo.email || '').trim().toLowerCase();
  const telefone = corpo.telefone ? String(corpo.telefone).trim() : null;
  const nivel = String(corpo.nivel || 'gestor').trim();

  if (!nome) throw erro400('Informe o nome do usuário.');
  if (!EMAIL.test(email)) throw erro400('Informe um e-mail válido.');
  if (!NIVEIS.includes(nivel)) {
    throw erro400(`Nível de acesso inválido. Use um de: ${NIVEIS.join(', ')}.`);
  }

  /* O índice único de contas ignora maiúsculas e alcança também as contas
     arquivadas. Conferir antes devolve 409 com explicação, em vez de deixar o
     banco estourar um erro de restrição que viraria 500. */
  if (db.um('SELECT id FROM contas WHERE lower(email) = ?', email)) {
    throw erro409('Já existe uma conta com este e-mail.');
  }

  const senha = senhaTemporaria();
  const guardada = auth.criarSenha(senha);
  const id = novoId('u');
  const criado = db.agora();

  db.transacao(() => {
    db.executar(
      `INSERT INTO contas (id, nome, email, telefone, senha_hash, senha_salt, papel,
                           nivel, email_verificado, senha_provisoria, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 0, 1, ?)`,
      id, nome, email, telefone, guardada.senha_hash, guardada.senha_salt, nivel, criado
    );

    regras.registrar(ctx, 'usuario', nome, 'cadastrou um administrador', `${email} · nível ${nivel}`);

    /* Entrega a senha temporária ao próprio novo administrador — sem este
       envio ele não teria como acessar o painel, e a tela do master claramente
       promete "a senha temporária foi enviada por e-mail". O modeloId aponta
       para MODELOS_EMAIL['admin-conta-criada']; correio.enviar() não lança —
       se o SMTP recusar, a linha vira 'falhou' em emails_enviados e a
       transação não é desfeita: perder o cadastro por causa do e-mail seria
       pior que registrar a falha e o master reenviar. */
    correio.enviar({
      modeloId: 'admin-conta-criada',
      para: email,
      destino: 'Novo administrador',
      contexto: {
        usuario: { nome, email, telefone: telefone || '', nivel },
        senha: { temporaria: senha }
      },
      qtd: 1
    });
  });

  ctx.ok({
    ok: true,
    usuario: mapa.adminUsuario(db.um('SELECT * FROM contas WHERE id = ?', id)),
    /* Única vez em que esta senha existe fora do sorteio: o banco guarda só o
       hash scrypt, então ela não pode ser consultada nem reenviada depois. É
       assim que o master a entrega ao novo administrador, que é obrigado a
       trocá-la no primeiro acesso (senha_provisoria = 1) e a confirmar o
       código enviado ao e-mail (email_verificado = 0). */
    senhaTemporaria: senha
  });
}

async function atualizarUsuario(ctx) {
  const master = exigirMaster(ctx, 'alterar administradores');
  const alvo = adminAtivo(ctx.params.id);
  const corpo = await ctx.corpo();

  /* Campo ausente mantém o valor atual: a tela envia só o que mudou. */
  const nome = corpo.nome === undefined ? alvo.nome : String(corpo.nome).trim();
  const email = corpo.email === undefined
    ? String(alvo.email).toLowerCase()
    : String(corpo.email).trim().toLowerCase();
  const telefone = corpo.telefone === undefined
    ? alvo.telefone
    : (String(corpo.telefone).trim() || null);
  const nivel = corpo.nivel === undefined ? alvo.nivel : String(corpo.nivel).trim();

  if (!nome) throw erro400('Informe o nome do usuário.');
  if (!EMAIL.test(email)) throw erro400('Informe um e-mail válido.');
  if (!NIVEIS.includes(nivel)) {
    throw erro400(`Nível de acesso inválido. Use um de: ${NIVEIS.join(', ')}.`);
  }

  /* Ficar sem nenhum master tranca o sistema inteiro: ninguém mais cadastraria
     usuário, apuraria campeonato ou corrigiria o ranking. */
  if (alvo.nivel === 'master' && nivel !== 'master') {
    if (alvo.id === master.id) {
      throw erro409(
        'Você não pode rebaixar o seu próprio acesso master. Peça a outro administrador master.'
      );
    }
    if (contarMasters() <= 1) {
      throw erro409('Este é o único administrador master ativo. Promova outro antes de rebaixá-lo.');
    }
  }

  const emailMudou = email !== String(alvo.email).toLowerCase();
  if (emailMudou && db.um('SELECT id FROM contas WHERE lower(email) = ? AND id <> ?', email, alvo.id)) {
    throw erro409('Já existe uma conta com este e-mail.');
  }

  db.transacao(() => {
    db.executar(
      `UPDATE contas
          SET nome = ?, email = ?, telefone = ?, nivel = ?,
              email_verificado = ?, atualizado_em = ?
        WHERE id = ?`,
      nome, email, telefone, nivel,
      /* Endereço novo volta a valer como não verificado: só o código enviado
         para ele prova que a caixa existe e é do usuário. */
      emailMudou ? 0 : alvo.email_verificado,
      db.agora(), alvo.id
    );

    const mudancas = [];
    if (nome !== alvo.nome) mudancas.push(`nome: ${alvo.nome} → ${nome}`);
    if (emailMudou) mudancas.push(`e-mail: ${alvo.email} → ${email}`);
    if (nivel !== alvo.nivel) mudancas.push(`nível: ${alvo.nivel} → ${nivel}`);

    regras.registrar(
      ctx, 'usuario', nome, 'alterou um administrador',
      mudancas.join(' · ') || 'sem mudança de nome, e-mail ou nível'
    );
  });

  ctx.ok({ ok: true, usuario: mapa.adminUsuario(db.um('SELECT * FROM contas WHERE id = ?', alvo.id)) });
}

/** Remoção lógica: o cadastro vai para o histórico e pode ser restaurado. */
async function arquivarUsuario(ctx) {
  const master = exigirMaster(ctx, 'remover administradores');
  const alvo = adminAtivo(ctx.params.id);

  if (alvo.id === master.id) {
    throw erro409('Você não pode remover o próprio acesso. Peça a outro administrador master.');
  }
  if (alvo.nivel === 'master' && contarMasters() <= 1) {
    throw erro409('Este é o único administrador master ativo. Promova outro antes de removê-lo.');
  }

  const quando = db.agora();

  db.transacao(() => {
    db.executar(
      'UPDATE contas SET arquivado_em = ?, atualizado_em = ? WHERE id = ?',
      quando, quando, alvo.id
    );

    /* A conta arquivada já não passa por contaDaSessao, então o acesso cai na
       hora. As sessões são apagadas mesmo assim para que uma restauração não
       reabra sessões antigas que ficaram guardadas no meio-tempo. */
    auth.encerrarTodasAsSessoes(alvo.id);

    regras.registrar(
      ctx, 'usuario', alvo.nome, 'removeu o acesso', `${alvo.email} · nível ${alvo.nivel}`
    );
  });

  ctx.ok({ ok: true, id: alvo.id, nome: alvo.nome, arquivado: true, arquivadoEm: quando });
}

/* ==========================================================================
   RANKING

   Quem alimenta o ranking é a apuração do campeonato — é a regra do briefing.
   O que existe aqui é a correção manual do master, e ela é auditada justamente
   por ser a exceção a essa regra.
   ========================================================================== */

/** Público: é o ranking nacional que o site mostra. */
async function lerRanking(ctx) {
  const modalidadeId = modalidadeValida(ctx.params.modalidade);

  /* Mesma ordenação de /api/bootstrap, para a API e o payload que o site já
     tem em cache nunca mostrarem a tabela em ordens diferentes. */
  const linhas = db.todos(
    `SELECT * FROM ranking
      WHERE modalidade = ?
      ORDER BY COALESCE(posicao, 9999), v DESC, nome`,
    modalidadeId
  );

  const config = db.um('SELECT * FROM ranking_config WHERE modalidade = ?', modalidadeId);

  /* Campeonatos encerrados da modalidade, que a tela de ranking lista embaixo
     da tabela — cada um abre a própria classificação final. */
  const campeonatos = db.todos(
    `SELECT id, nome, data, classificacao FROM campeonatos
      WHERE modalidade = ? AND status = 'encerrado' AND arquivado_em IS NULL
      ORDER BY data DESC, id`,
    modalidadeId
  ).map((c) => ({
    id: c.id,
    nome: c.nome,
    data: mapa.soData(c.data),
    classificacao: db.json(c.classificacao)
  }));

  ctx.ok({
    ok: true,
    modalidade: modalidadeId,
    total: linhas.length,
    ranking: mapa.lista(linhas, mapa.rankingLinha),
    /* `ativo` é informado, não aplicado: /api/bootstrap devolve o ranking de
       toda modalidade e é de lá que o site lê. Filtrar só aqui faria a mesma
       tabela aparecer por um caminho e sumir pelo outro. */
    config: config ? mapa.rankingConfigLinha(config) : { ...mapa.RANKING_CONFIG_PADRAO },
    campeonatos
  });
}

/**
 * Ajuste manual. Duas formas:
 *   { linhas: [...] }  substitui a classificação inteira da modalidade — a
 *                      ordem do array vira a colocação de quem não trouxer
 *                      `pos`, e quem não aparecer sai da tabela;
 *   { nome, ... }      corrige (ou cria) uma linha só, sem mexer no resto.
 */
async function salvarRanking(ctx) {
  exigirMaster(ctx, 'ajustar o ranking');
  const modalidadeId = modalidadeValida(ctx.params.modalidade);
  const corpo = await ctx.corpo();

  const substituir = Array.isArray(corpo.linhas);
  const linhas = substituir ? corpo.linhas : (corpo.nome ? [corpo] : null);

  if (!linhas || !linhas.length) {
    throw erro400('Envie { linhas: [...] } com a classificação ou os campos de uma única linha.');
  }

  const curto = regras.modalidade(modalidadeId).curto;
  const salvas = [];

  db.transacao(() => {
    if (substituir) db.executar('DELETE FROM ranking WHERE modalidade = ?', modalidadeId);

    linhas.forEach((l, indice) => {
      const nome = String(l.nome || '').trim();
      if (!nome) throw erro400('Toda linha do ranking precisa do nome do time ou do atleta.');

      /* Numa correção avulsa, o que não veio no corpo continua como está —
         inclusive a colocação, que não pode ser zerada sem querer. */
      const atual = substituir
        ? null
        : db.um('SELECT * FROM ranking WHERE modalidade = ? AND nome = ?', modalidadeId, nome);

      const posicao = l.pos === undefined || l.pos === null || l.pos === ''
        ? (substituir ? indice + 1 : (atual ? atual.posicao : null))
        : Math.max(1, inteiro(l.pos, indice + 1, 1));

      db.executar(
        `INSERT INTO ranking (modalidade, nome, uf, v, e, d, camp, titulos, gotf, posicao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (modalidade, nome) DO UPDATE SET
           uf = excluded.uf, v = excluded.v, e = excluded.e, d = excluded.d,
           camp = excluded.camp, titulos = excluded.titulos,
           gotf = excluded.gotf, posicao = excluded.posicao`,
        modalidadeId, nome,
        l.uf === undefined ? (atual ? atual.uf : null) : (String(l.uf).trim().toUpperCase() || null),
        contagem(l.v, atual ? atual.v : 0),
        contagem(l.e, atual ? atual.e : 0),
        contagem(l.d, atual ? atual.d : 0),
        contagem(l.camp, atual ? atual.camp : 0),
        contagem(l.titulos, atual ? atual.titulos : 0),
        db.paraBool(l.gotf === undefined ? (atual ? atual.gotf : 0) : l.gotf),
        posicao
      );

      salvas.push(nome);
    });

    regras.registrar(
      ctx, 'ranking',
      substituir ? curto : salvas[0],
      substituir ? 'reordenou o ranking' : 'corrigiu a colocação',
      substituir ? `${curto} · ${salvas.length} linha(s)` : `${curto} · ${salvas.join(', ')}`
    );
  });

  const atualizado = db.todos(
    `SELECT * FROM ranking
      WHERE modalidade = ?
      ORDER BY COALESCE(posicao, 9999), v DESC, nome`,
    modalidadeId
  );

  ctx.ok({
    ok: true,
    modalidade: modalidadeId,
    substituido: substituir,
    ranking: mapa.lista(atualizado, mapa.rankingLinha)
  });
}

/* --------------------------------------------------------------------------
   CONDIÇÕES DE CÁLCULO DO RANKING
   -------------------------------------------------------------------------- */

async function lerRankingConfig(ctx) {
  exigirMaster(ctx, 'ver as condições do ranking');
  const modalidadeId = modalidadeValida(ctx.params.modalidade);

  const linha = db.um('SELECT * FROM ranking_config WHERE modalidade = ?', modalidadeId);

  ctx.ok({
    ok: true,
    modalidade: modalidadeId,
    /* Modalidade sem linha configurada responde com o padrão do esquema, para
       a tela nunca receber nulo e ter que inventar valor. */
    config: linha ? mapa.rankingConfigLinha(linha) : { ...mapa.RANKING_CONFIG_PADRAO }
  });
}

async function salvarRankingConfig(ctx) {
  exigirMaster(ctx, 'alterar as condições do ranking');
  const modalidadeId = modalidadeValida(ctx.params.modalidade);
  const corpo = await ctx.corpo();

  const linha = db.um('SELECT * FROM ranking_config WHERE modalidade = ?', modalidadeId);
  const atual = linha ? mapa.rankingConfigLinha(linha) : { ...mapa.RANKING_CONFIG_PADRAO };

  /* paraLinhaRankingConfig transforma campo ausente em zero, então a mescla
     com o valor atual precisa acontecer ANTES — senão um PUT parcial zeraria
     toda a pontuação. */
  const nova = mapa.paraLinhaRankingConfig({ ...atual, ...corpo }, modalidadeId);

  db.transacao(() => {
    db.executar(
      `INSERT INTO ranking_config (modalidade, pontos_vitoria, pontos_empate, pontos_derrota,
                                   bonus_titulo, bonus_gotf, min_campeonatos, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (modalidade) DO UPDATE SET
         pontos_vitoria = excluded.pontos_vitoria,
         pontos_empate = excluded.pontos_empate,
         pontos_derrota = excluded.pontos_derrota,
         bonus_titulo = excluded.bonus_titulo,
         bonus_gotf = excluded.bonus_gotf,
         min_campeonatos = excluded.min_campeonatos,
         ativo = excluded.ativo`,
      nova.modalidade, nova.pontos_vitoria, nova.pontos_empate, nova.pontos_derrota,
      nova.bonus_titulo, nova.bonus_gotf, nova.min_campeonatos, nova.ativo
    );

    regras.registrar(
      ctx, 'ranking', regras.modalidade(modalidadeId).curto,
      'alterou as condições de cálculo',
      `vitória ${nova.pontos_vitoria} · empate ${nova.pontos_empate} · ` +
      `derrota ${nova.pontos_derrota} · título ${nova.bonus_titulo} · GOTF ${nova.bonus_gotf}`
    );
  });

  ctx.ok({
    ok: true,
    modalidade: modalidadeId,
    config: mapa.rankingConfigLinha(
      db.um('SELECT * FROM ranking_config WHERE modalidade = ?', modalidadeId)
    )
  });
}

/* ==========================================================================
   HISTÓRICO

   Exclusão em duas etapas, como no protótipo: arquivar tira de circulação,
   restaurar traz de volta e só a exclusão definitiva apaga de verdade.
   ========================================================================== */

/** O que está arquivado em todas as tabelas da lista branca. */
async function listarHistorico(ctx) {
  ctx.exigirAdmin();

  const pedida = ctx.query.get('tabela');
  const nomes = pedida ? [tabelaDoHistorico(pedida).nome] : Object.keys(TABELAS_HISTORICO);
  const limite = inteiro(ctx.query.get('limite'), HISTORICO_LIMITE, 1, HISTORICO_LIMITE_MAX);

  const itens = [];

  nomes.forEach((chave) => {
    const t = TABELAS_HISTORICO[chave];
    /* Tabela e coluna são literais da lista branca acima. O teto por tabela
       impede que uma delas, sozinha, encha a resposta inteira. */
    db.todos(
      `SELECT id, "${t.coluna}" AS nome, arquivado_em FROM ${t.tabela}
        WHERE arquivado_em IS NOT NULL
        ORDER BY arquivado_em DESC
        LIMIT ?`,
      limite
    ).forEach((l) => itens.push({
      tabela: chave,
      rotulo: t.rotulo,
      id: l.id,
      nome: l.nome || '(sem nome)',
      data: l.arquivado_em
    }));
  });

  itens.sort((a, b) => String(b.data).localeCompare(String(a.data)));

  ctx.ok({ ok: true, total: itens.length, itens: itens.slice(0, limite) });
}

/** Lê a linha alvo já sabendo qual é a coluna de nome da tabela. */
function linhaDoHistorico(t, id) {
  const linha = db.um(
    `SELECT id, "${t.coluna}" AS nome, arquivado_em FROM ${t.tabela} WHERE id = ?`, id
  );
  if (!linha) throw erro404(`Nenhum registro de ${t.rotulo} com o id informado.`);
  return linha;
}

/** Identificador do registro: chega no corpo e, no DELETE, também na query. */
function alvoDoHistorico(corpo, ctx) {
  const t = tabelaDoHistorico(corpo.tabela || ctx.query.get('tabela'));
  const id = String(corpo.id || ctx.query.get('id') || '').trim();
  if (!id) throw erro400('Informe o id do registro.');
  return { t, id };
}

async function restaurarHistorico(ctx) {
  exigirMaster(ctx, 'restaurar registros do histórico');
  const { t, id } = alvoDoHistorico(await ctx.corpo(), ctx);

  const linha = linhaDoHistorico(t, id);
  if (!linha.arquivado_em) throw erro409('Este registro não está no histórico.');

  db.transacao(() => {
    db.executar(`UPDATE ${t.tabela} SET arquivado_em = NULL WHERE id = ?`, id);
    regras.registrar(ctx, t.area, linha.nome, 'restaurou do histórico', `${t.rotulo} · ${id}`);
  });

  ctx.ok({ ok: true, tabela: t.nome, id, nome: linha.nome, restaurado: true });
}

async function excluirHistorico(ctx) {
  exigirMaster(ctx, 'excluir registros em definitivo');
  const { t, id } = alvoDoHistorico(await ctx.corpo(), ctx);

  const linha = linhaDoHistorico(t, id);

  /* Segunda etapa da exclusão: o registro precisa ter passado pelo histórico.
     Sem isso, um pedido errado apagaria de uma vez algo que ainda está em uso. */
  if (!linha.arquivado_em) {
    throw erro409(
      'Só é possível excluir em definitivo o que já está no histórico. Remova o registro antes.'
    );
  }

  db.transacao(() => {
    /* Apaga em cascata o que depende do registro (conta leva junto times,
       jogadores, comissão, documentos e inscrições, pelas chaves estrangeiras
       do esquema). É a única operação do sistema que não tem volta. */
    db.executar(`DELETE FROM ${t.tabela} WHERE id = ?`, id);
    /* A tabela `traducoes` é genérica e não tem chave estrangeira para lugar
       nenhum, então o CASCADE não a alcança: sem esta linha, a tradução ficaria
       órfã e voltaria a ser lida se um registro novo reusasse o mesmo id. */
    traducoes.apagarRegistro(t.tabela, id);
    regras.registrar(ctx, t.area, linha.nome, 'excluiu em definitivo', `${t.rotulo} · ${id}`);
  });

  ctx.ok({ ok: true, tabela: t.nome, id, nome: linha.nome, excluido: true });
}

/* ==========================================================================
   REGISTRO DAS ROTAS
   ========================================================================== */

function registrar(rotas) {
  rotas.get('/api/admin/metricas', metricas);

  rotas.get('/api/admin/usuarios', listarUsuarios);
  rotas.post('/api/admin/usuarios', criarUsuario);
  rotas.put('/api/admin/usuarios/:id', atualizarUsuario);
  rotas.delete('/api/admin/usuarios/:id', arquivarUsuario);

  rotas.get('/api/ranking/:modalidade', lerRanking);
  rotas.put('/api/ranking/:modalidade', salvarRanking);
  rotas.get('/api/ranking-config/:modalidade', lerRankingConfig);
  rotas.put('/api/ranking-config/:modalidade', salvarRankingConfig);

  rotas.get('/api/historico', listarHistorico);
  rotas.post('/api/historico/restaurar', restaurarHistorico);
  rotas.delete('/api/historico', excluirHistorico);
}

module.exports = { registrar, TABELAS_HISTORICO, NIVEIS };
