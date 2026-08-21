/* ==========================================================================
   PHYGITAL BRASIL — TRADUÇÃO ENTRE BANCO E FRONT-END

   O front-end tem ~50 páginas com script embutido que leem PB.dados.* de forma
   SÍNCRONA (D.campeonatos(), D.time(id), D.ranking('futebol')...). Nenhuma
   dessas páginas pode ser alterada. A estratégia é hidratar um cache em memória
   com uma única chamada a /api/bootstrap e manter as leituras síncronas.

   Para isso o servidor precisa devolver EXATAMENTE a forma que a antiga função
   semente() do front-end devolvia. Este arquivo é essa fronteira: banco em
   snake_case de um lado, camelCase do front-end do outro. Nenhuma rota deve
   montar payload na mão — se a forma mudar, muda aqui e em nenhum outro lugar.

   Todas as funções são puras: recebem linha (ou linhas) e devolvem objeto. Nada
   consulta o banco — quem chama faz as consultas e passa as partes prontas.

   As inversas (paraLinha*) montam a linha COMPLETA, com todas as colunas da
   tabela: campo ausente vira NULL. Para atualização parcial, a rota deve
   mesclar com a linha atual ANTES de chamar, senão apaga o que não enviou.
   ========================================================================== */
'use strict';

const db = require('./db');

/* --------------------------------------------------------------------------
   APOIO DE DATA

   A semente usava data pura ('2026-08-09') em criadoEm, abertoEm e afins,
   enquanto o banco grava ISO completo. O front-end formata cortando a string,
   então o corte tem que acontecer aqui para a tela não mostrar o horário.
   -------------------------------------------------------------------------- */

const soData = (v) => (v ? String(v).slice(0, 10) : null);

const pad = (n) => String(n).padStart(2, '0');

/** ISO → 'DD/MM/AAAA HH:MM', o rótulo que as telas exibem. */
function dataHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Alguns campos guardam rótulo já pronto (digitado pelo usuário ou vindo da
 * semente) e outros guardam ISO gerado pelo servidor. O front-end imprime o
 * valor cru, então só formatamos o que é claramente ISO.
 */
const horaLegivel = (v) => (v && String(v).includes('T') ? dataHora(v) : (v || ''));

/** Aplica um mapeador em lista, tolerando null/undefined. */
const lista = (linhas, fn, ...extra) => (linhas || []).map((l) => fn(l, ...extra));

/* ==========================================================================
   CAMPEONATO
   ========================================================================== */

/**
 * medalhaAte e trofeuAte são escritos por admin/campeonato-novo.html mas não
 * têm coluna no esquema. Viajam dentro do JSON de premiação (são dados de
 * premiação) e voltam ao topo do objeto na leitura. Um objeto de premiação sem
 * `tipo` significa "campeonato sem premiação, só medalha/troféu".
 */
function premiacaoDe(bruto) {
  if (!bruto || !bruto.tipo) return null;
  const { medalhaAte, trofeuAte, ...premiacao } = bruto;
  return premiacao;
}

/**
 * @param contagens {inscritos, oficial, espera} — derivadas da tabela
 *        inscricoes por quem consulta; o campeonato não guarda contador.
 */
function campeonato(l, contagens = {}) {
  const prem = db.json(l.premiacao);

  return {
    id: l.id,
    nome: l.nome,
    modalidade: l.modalidade,
    banner: l.banner,
    vagas: l.vagas,
    jogadoresMin: l.jogadores_min,
    jogadoresMax: l.jogadores_max,
    /* A coluna guarda o TETO de reservas (0 = campeonato sem reserva), mas o
       front-end sempre tratou `reservas` como sim/não. Devolvemos o sim/não que
       ele espera e o teto ao lado, para a edição não rebaixar 3 para 1. */
    reservas: Number(l.reservas) > 0,
    reservasMax: Number(l.reservas) || 0,
    staffMax: l.staff_max,
    data: soData(l.data),
    dataFim: soData(l.data_fim),
    local: l.local,
    aberturaInscricoes: soData(l.abertura_inscricoes),
    encerramentoInscricoes: soData(l.encerramento_inscricoes),
    descricao: l.descricao,
    premiacao: premiacaoDe(prem),
    medalhaAte: prem ? (prem.medalhaAte || null) : null,
    trofeuAte: prem ? (prem.trofeuAte || null) : null,
    termos: l.termos,
    regulamento: l.regulamento,
    status: l.status,
    classificacao: db.json(l.classificacao),
    inscritos: contagens.inscritos || 0,
    oficial: contagens.oficial || 0,
    espera: contagens.espera || 0,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaCampeonato(c, { id, criadoEm } = {}) {
  const premiacao = c.premiacao ? { ...c.premiacao } : {};
  if (c.medalhaAte) premiacao.medalhaAte = c.medalhaAte;
  if (c.trofeuAte) premiacao.trofeuAte = c.trofeuAte;

  return db.limpar({
    id: id || c.id,
    nome: c.nome,
    modalidade: c.modalidade,
    banner: c.banner,
    vagas: Number(c.vagas) || 0,
    jogadores_min: c.jogadoresMin == null ? null : Number(c.jogadoresMin),
    jogadores_max: c.jogadoresMax == null ? null : Number(c.jogadoresMax),
    /* Sem reserva zera o teto; com reserva mantém o teto que já existia, já que
       o formulário do admin só oferece um sim/não. */
    reservas: !c.reservas ? 0 : (Number(c.reservasMax) > 0 ? Number(c.reservasMax) : 1),
    staff_max: c.staffMax == null ? null : Number(c.staffMax),
    data: c.data || null,
    data_fim: c.dataFim || null,
    local: c.local,
    abertura_inscricoes: c.aberturaInscricoes || null,
    encerramento_inscricoes: c.encerramentoInscricoes || null,
    descricao: c.descricao,
    premiacao: Object.keys(premiacao).length ? db.paraJson(premiacao) : null,
    termos: c.termos,
    regulamento: c.regulamento,
    status: c.status || 'rascunho',
    classificacao: c.classificacao ? db.paraJson(c.classificacao) : null,
    criado_em: criadoEm || c.criadoEm || db.agora(),
    atualizado_em: db.agora()
  });
}

/* ==========================================================================
   TIME, JOGADORES, COMISSÃO E DOCUMENTOS
   ========================================================================== */

function documento(l) {
  return {
    id: l.id,
    tipo: l.tipo,
    arquivo: l.arquivo,
    validade: soData(l.validade),
    /* Devolvemos o status gravado, não o derivado: o front-end já transforma
       "aprovado com validade vencida" em "vencido" ao montar a tela. */
    status: l.status,
    observacao: l.observacao,
    enviadoEm: l.enviado_em,
    conferidoEm: l.conferido_em
  };
}

function paraLinhaDocumento(d, { id, jogadorId } = {}) {
  return db.limpar({
    id: id || d.id,
    jogador_id: jogadorId || d.jogadorId,
    tipo: d.tipo,
    arquivo: d.arquivo,
    validade: d.validade || null,
    status: d.status || 'pendente',
    observacao: d.observacao,
    enviado_em: d.enviadoEm || null,
    conferido_em: d.conferidoEm || null,
    conferido_por: d.conferidoPor || null
  });
}

function jogador(l, documentos = []) {
  return {
    id: l.id,
    nome: l.nome,
    apelido: l.apelido,
    numero: l.numero,
    funcao: l.funcao,
    email: l.email,
    tel: l.tel,
    nasc: soData(l.nasc),
    insta: l.insta,
    foto: l.foto,
    steam: l.steam,
    faceit: l.faceit,
    reserva: db.bool(l.reserva),
    documentos: lista(documentos, documento)
  };
}

function paraLinhaJogador(j, { id, timeId, ordem } = {}) {
  return db.limpar({
    id: id || j.id,
    time_id: timeId || j.timeId,
    ordem: ordem == null ? (Number(j.ordem) || 0) : ordem,
    nome: j.nome,
    apelido: j.apelido,
    numero: j.numero === '' || j.numero == null ? null : Number(j.numero),
    funcao: j.funcao,
    email: j.email,
    tel: j.tel,
    nasc: j.nasc || null,
    insta: j.insta,
    foto: j.foto,
    steam: j.steam,
    faceit: j.faceit,
    reserva: db.paraBool(j.reserva)
  });
}

function staff(l) {
  return {
    id: l.id,
    nome: l.nome,
    papel: l.papel,
    email: l.email,
    tel: l.tel,
    nasc: soData(l.nasc),
    insta: l.insta,
    foto: l.foto
  };
}

function paraLinhaStaff(s, { id, timeId, ordem } = {}) {
  return db.limpar({
    id: id || s.id,
    time_id: timeId || s.timeId,
    ordem: ordem == null ? (Number(s.ordem) || 0) : ordem,
    nome: s.nome,
    papel: s.papel,
    email: s.email,
    tel: s.tel,
    nasc: s.nasc || null,
    insta: s.insta,
    foto: s.foto
  });
}

/**
 * @param jogadores  linhas de `jogadores` NA ORDEM em que devem aparecer — o
 *                   front-end usa o índice do array para gravar documento.
 * @param equipe     linhas de `staff`
 * @param docsPorJogador  { jogador_id: [linhas de documentos] }
 */
function time(l, jogadores = [], equipe = [], docsPorJogador = {}) {
  return {
    id: l.id,
    conta: l.conta_id,
    nome: l.nome,
    modalidade: l.modalidade,
    categoria: l.categoria,
    escudo: l.escudo,
    descricao: l.descricao,
    historico: l.historico,
    criadoEm: soData(l.criado_em),
    atualizadoEm: l.atualizado_em,
    jogadores: (jogadores || []).map((j) => jogador(j, docsPorJogador[j.id] || [])),
    staff: lista(equipe, staff),
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaTime(t, { id, contaId, criadoEm } = {}) {
  return db.limpar({
    id: id || t.id,
    conta_id: contaId || t.conta,
    nome: t.nome,
    modalidade: t.modalidade,
    categoria: t.categoria || null,
    escudo: t.escudo || null,
    descricao: t.descricao,
    historico: t.historico,
    criado_em: criadoEm || t.criadoEm || db.agora(),
    atualizado_em: db.agora()
  });
}

/* ==========================================================================
   INSCRIÇÃO
   ========================================================================== */

/**
 * `campeonato` e `time` carregam IDs — é assim que as telas cruzam com
 * D.campeonato(id) e D.time(id).
 *
 * A tabela não tem arquivado_em: cancelar uma inscrição é mudar o status para
 * 'cancelada'. Como o front-end joga inscrição cancelada no histórico via
 * D.arquivados('minhasInscricoes'), 'cancelada' é o que virou `arquivado`.
 */
function inscricao(l) {
  return {
    id: l.id,
    campeonato: l.campeonato_id,
    time: l.time_id,
    protocolo: l.protocolo,
    status: l.status,
    data: soData(l.data),
    observacao: l.observacao,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
    arquivado: l.status === 'cancelada'
  };
}

function paraLinhaInscricao(i, { id, criadoEm } = {}) {
  return db.limpar({
    id: id || i.id,
    campeonato_id: i.campeonato,
    time_id: i.time,
    protocolo: i.protocolo,
    /* Nunca aceita status de fora: toda inscrição nasce em triagem e só o
       admin move para oficial ou espera. */
    status: i.status || 'triagem',
    data: i.data || db.agora().slice(0, 10),
    observacao: i.observacao,
    criado_em: criadoEm || i.criadoEm || db.agora(),
    atualizado_em: db.agora()
  });
}

/* ==========================================================================
   CHAMADOS
   ========================================================================== */

function mensagem(l) {
  return {
    de: l.de,
    autor: l.autor,
    texto: l.texto,
    /* `hora` é rótulo de exibição; quando não veio gravado, usa o carimbo. */
    hora: l.hora || dataHora(l.criado_em)
  };
}

function paraLinhaMensagem(m, { chamadoId } = {}) {
  return db.limpar({
    chamado_id: chamadoId || m.chamadoId,
    de: m.de || 'usuario',
    autor: m.autor,
    texto: m.texto,
    hora: m.hora || dataHora(db.agora()),
    criado_em: db.agora()
  });
}

/** Forma do painel do competidor: sem nome de time, com a conversa completa. */
function chamado(l, mensagens = []) {
  return {
    id: l.id,
    protocolo: l.protocolo,
    assunto: l.assunto,
    campeonato: l.campeonato_id,
    timeId: l.time_id,
    status: l.status,
    autor: l.autor,
    abertoEm: soData(l.aberto_em),
    atualizadoEm: soData(l.atualizado_em),
    mensagens: lista(mensagens, mensagem),
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

/**
 * Forma do painel do administrador. Aqui `time` é o NOME do time, porque
 * admin/chamados.html imprime esse campo direto numa coluna da tabela — quem
 * consulta precisa trazer times.nome no SELECT (coluna `time_nome`).
 *
 * A conversa vai junto de propósito: admin/chamado.html procura as mensagens
 * primeiro em adminChamados e só depois na lista do competidor, que o admin
 * não recebe (é dado de outra conta).
 */
function chamadoAdmin(l, mensagens = []) {
  return {
    id: l.id,
    protocolo: l.protocolo,
    assunto: l.assunto,
    /* Chamado aberto sem time vinculado (contato avulso) cai no autor, que é
       quem a tela identifica de fato — '—' só quando não há nem isso. */
    time: l.time_nome || l.autor || '—',
    timeId: l.time_id,
    campeonato: l.campeonato_id,
    status: l.status,
    autor: l.autor,
    abertoEm: soData(l.aberto_em),
    atualizadoEm: soData(l.atualizado_em),
    mensagens: lista(mensagens, mensagem),
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaChamado(c, { id, contaId, criadoEm } = {}) {
  return db.limpar({
    id: id || c.id,
    protocolo: c.protocolo,
    conta_id: contaId || c.conta || null,
    campeonato_id: c.campeonato && c.campeonato !== 'geral' ? c.campeonato : null,
    time_id: c.timeId || null,
    assunto: c.assunto,
    status: c.status || 'aberto',
    autor: c.autor,
    aberto_em: criadoEm || c.abertoEm || db.agora(),
    atualizado_em: db.agora()
  });
}

/* ==========================================================================
   RANKING E RESULTADOS
   ========================================================================== */

function rankingLinha(l) {
  return {
    nome: l.nome,
    uf: l.uf,
    v: l.v,
    e: l.e,
    d: l.d,
    camp: l.camp,
    titulos: l.titulos,
    gotf: db.bool(l.gotf),
    pos: l.posicao
  };
}

/**
 * O front-end acessa ranking[modalidade] direto, sem checar se a chave existe
 * (admin/ranking.html chega a indexar ranking[mod][i]). Toda modalidade recebe
 * array, mesmo vazio, para não estourar.
 *
 * A ordem das linhas é preservada: quem consulta define o ORDER BY.
 */
function rankingPorModalidade(linhas, chaves = []) {
  const saida = {};
  chaves.forEach((k) => { saida[k] = []; });

  (linhas || []).forEach((l) => {
    if (!saida[l.modalidade]) saida[l.modalidade] = [];
    saida[l.modalidade].push(rankingLinha(l));
  });

  return saida;
}

/* Mesmos números do DDL — usados quando a modalidade ainda não tem linha. */
const RANKING_CONFIG_PADRAO = {
  pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0,
  bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true
};

function rankingConfigLinha(l) {
  return {
    pontosVitoria: l.pontos_vitoria,
    pontosEmpate: l.pontos_empate,
    pontosDerrota: l.pontos_derrota,
    bonusTitulo: l.bonus_titulo,
    bonusGotf: l.bonus_gotf,
    minCampeonatos: l.min_campeonatos,
    ativo: db.bool(l.ativo)
  };
}

function rankingConfigPorModalidade(linhas, chaves = []) {
  const saida = {};
  chaves.forEach((k) => { saida[k] = { ...RANKING_CONFIG_PADRAO }; });
  (linhas || []).forEach((l) => { saida[l.modalidade] = rankingConfigLinha(l); });
  return saida;
}

function paraLinhaRankingConfig(cfg, modalidade) {
  return db.limpar({
    modalidade,
    pontos_vitoria: Number(cfg.pontosVitoria) || 0,
    pontos_empate: Number(cfg.pontosEmpate) || 0,
    pontos_derrota: Number(cfg.pontosDerrota) || 0,
    bonus_titulo: Number(cfg.bonusTitulo) || 0,
    bonus_gotf: Number(cfg.bonusGotf) || 0,
    min_campeonatos: Number(cfg.minCampeonatos) || 0,
    ativo: db.paraBool(cfg.ativo)
  });
}

/** Placar phygital: as duas metades ficam em colunas planas e voltam aninhadas. */
function resultado(l) {
  return {
    id: l.id,
    data: soData(l.data),
    mod: l.mod,
    camp: l.camp,
    local: l.local,
    fase: l.fase,
    casa: { nome: l.casa_nome, escudo: l.casa_escudo, digital: l.casa_digital, fisico: l.casa_fisico },
    fora: { nome: l.fora_nome, escudo: l.fora_escudo, digital: l.fora_digital, fisico: l.fora_fisico }
  };
}

function paraLinhaResultado(r) {
  const casa = r.casa || {};
  const fora = r.fora || {};
  return db.limpar({
    data: r.data || null,
    mod: r.mod,
    camp: r.camp,
    local: r.local,
    fase: r.fase,
    casa_nome: casa.nome, casa_escudo: casa.escudo,
    casa_digital: casa.digital, casa_fisico: casa.fisico,
    fora_nome: fora.nome, fora_escudo: fora.escudo,
    fora_digital: fora.digital, fora_fisico: fora.fisico
  });
}

/* ==========================================================================
   CONTEÚDO PÚBLICO
   ========================================================================== */

function post(l) {
  const publicado = db.bool(l.publicado);
  return {
    id: l.id,
    titulo: l.titulo,
    cat: l.cat,
    data: soData(l.data),
    autor: l.autor,
    img: l.img,
    resumo: l.resumo,
    corpo: l.corpo,
    publicado,
    /* admin/blog-post.html grava o inverso deste campo ao salvar rascunho. */
    rascunho: !publicado,
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaPost(p, { id, criadoEm } = {}) {
  return db.limpar({
    id: id || p.id,
    titulo: p.titulo,
    cat: p.cat,
    data: p.data || db.agora().slice(0, 10),
    autor: p.autor,
    img: p.img,
    resumo: p.resumo,
    corpo: p.corpo,
    publicado: db.paraBool(p.rascunho === undefined ? p.publicado !== false : !p.rascunho),
    criado_em: criadoEm || p.criadoEm || db.agora(),
    atualizado_em: db.agora()
  });
}

function evento(l) {
  return {
    id: l.id,
    titulo: l.titulo,
    mod: l.mod,
    ano: l.ano,
    local: l.local,
    fotos: l.fotos,
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

/* A ordem importa: parceiros.html e a home escolhem o logo pelo índice da
   lista, então o mesmo parceiro precisa cair sempre na mesma posição. */
function parceiro(l) {
  return {
    id: l.id,
    nome: l.nome,
    tipo: l.tipo,
    logo: l.logo,
    ordem: l.ordem,
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function categoria(l) {
  return {
    id: l.id,
    nome: l.nome,
    descricao: l.descricao,
    cor: l.cor,
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaCategoria(c) {
  return db.limpar({
    id: c.id,
    nome: c.nome,
    descricao: c.descricao,
    cor: c.cor
  });
}

function banner(l) {
  return {
    id: l.id,
    titulo: l.titulo,
    img: l.img,
    link: l.link,
    ordem: l.ordem,
    ativo: db.bool(l.ativo),
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaBanner(b, { id } = {}) {
  return db.limpar({
    id: id || b.id,
    titulo: b.titulo,
    img: b.img,
    link: b.link,
    ordem: Number(b.ordem) || 0,
    ativo: db.paraBool(b.ativo === undefined ? true : b.ativo)
  });
}

function bannerSite(l) {
  return {
    id: l.id,
    titulo: l.titulo,
    texto: l.texto,
    eyebrow: l.eyebrow,
    botao: l.botao,
    link: l.link,
    botao2: l.botao2,
    link2: l.link2,
    midia: l.midia,
    img: l.img,
    video: l.video,
    tituloTamanho: l.titulo_tamanho,
    semTexto: db.bool(l.sem_texto),
    ordem: l.ordem,
    ativo: db.bool(l.ativo),
    arquivado: Boolean(l.arquivado_em),
    arquivadoEm: l.arquivado_em
  };
}

function paraLinhaBannerSite(b, { id } = {}) {
  const linha = db.limpar({
    id: id || b.id,
    titulo: b.titulo || '',
    texto: b.texto || '',
    eyebrow: b.eyebrow || '',
    botao: b.botao || '',
    link: b.link || '',
    botao2: b.botao2 || '',
    link2: b.link2 || '',
    midia: b.midia === 'video' ? 'video' : 'imagem',
    img: b.img || null,
    video: b.video || '',
    titulo_tamanho: Number(b.tituloTamanho) || 0,
    sem_texto: db.paraBool(b.semTexto),
    ordem: Number(b.ordem) || 0,
    ativo: db.paraBool(b.ativo === undefined ? true : b.ativo),
    /* admin/banners-site.html arquiva e restaura gravando b.arquivado no
       próprio objeto, não por DELETE. Sem mapear, "Remover da rotação" e
       "Restaurar" respondiam 200 e não faziam nada. */
    arquivado_em: b.arquivado ? (b.arquivadoEm || db.agora()) : null
  });

  /* db.limpar troca undefined por null, então a chave precisa sair da linha
     quando a tela não mandou o campo — senão toda gravação desarquivaria o
     banner sem querer. */
  if (b.arquivado === undefined) delete linha.arquivado_em;

  return linha;
}

/* ==========================================================================
   E-MAIL
   ========================================================================== */

/**
 * A senha do SMTP nunca sai do servidor — nem existe coluna para ela (vem do
 * ambiente). Sem linha configurada devolve objeto vazio, porque admin/email.js
 * indexa a configuração sem checar nulo.
 */
function smtp(l) {
  if (!l) return {};
  return {
    email: l.email,
    usuario: l.usuario,
    servidorEntrada: l.servidor_entrada,
    imap: l.imap,
    pop3: l.pop3,
    servidorSaida: l.servidor_saida,
    smtp: l.smtp,
    seguranca: l.seguranca,
    remetente: l.remetente,
    atualizadoEm: l.atualizado_em
  };
}

function paraLinhaSmtp(s) {
  return db.limpar({
    id: 1,
    email: s.email,
    usuario: s.usuario,
    servidor_entrada: s.servidorEntrada,
    imap: s.imap == null || s.imap === '' ? null : Number(s.imap),
    pop3: s.pop3 == null || s.pop3 === '' ? null : Number(s.pop3),
    servidor_saida: s.servidorSaida,
    smtp: s.smtp == null || s.smtp === '' ? null : Number(s.smtp),
    seguranca: s.seguranca,
    remetente: s.remetente,
    atualizado_em: db.agora()
  });
}

function modeloEmail(l) {
  return {
    id: l.id,
    grupo: l.grupo,
    nome: l.nome,
    quando: l.quando,
    para: l.para,
    assunto: l.assunto,
    corpo: l.corpo,
    ativo: db.bool(l.ativo)
  };
}

function paraLinhaModeloEmail(m) {
  return db.limpar({
    id: m.id,
    grupo: m.grupo,
    nome: m.nome,
    quando: m.quando,
    para: m.para === 'admin' ? 'admin' : 'competidor',
    assunto: m.assunto,
    corpo: m.corpo,
    ativo: db.paraBool(m.ativo === undefined ? true : m.ativo),
    atualizado_em: db.agora()
  });
}

function emailEnviado(l) {
  return {
    id: l.id,
    modeloId: l.modelo_id,
    assunto: l.assunto,
    destino: l.destino,
    para: l.para,
    corpo: l.corpo,
    qtd: l.qtd,
    status: l.status,
    erro: l.erro,
    data: horaLegivel(l.data),
    /* Estado do despachante (server/fila-email.js). Numa linha recém-montada,
       que ainda não passou pelo banco, estas colunas não existem — daí os
       padrões em vez de undefined vazando para a resposta. */
    tentativas: Number(l.tentativas) || 0,
    proximaTentativa: l.proxima_tentativa || null,
    enviadoEm: l.enviado_em || null,
    /* Anexos vão como metadado só (nome, tipo, tamanho, caminho relativo). O
       binário está em site/assets/enviados/ — quem entrega é o despachante,
       que abre o arquivo do disco na hora de montar o multipart. */
    anexos: db.json(l.anexos, []) || []
  };
}

function paraLinhaEmailEnviado(e, { id } = {}) {
  return db.limpar({
    id: id || e.id,
    modelo_id: e.modeloId || null,
    assunto: e.assunto,
    destino: e.destino,
    para: e.para,
    corpo: e.corpo,
    qtd: Number(e.qtd) || 1,
    /* Em desenvolvimento nada sai de verdade: fica gravado como 'simulado'
       para poder ser inspecionado nos testes. */
    status: e.status || 'simulado',
    erro: e.erro || null,
    data: e.data || db.agora(),
    /* Lista de metadados dos anexos, para o dispatcher achar o arquivo no
       disco na hora de enviar. Nada de bytes: gravar base64 aqui estouraria o
       histórico (o teto de 100 MB por arquivo bate no teto de 2 MB do corpo). */
    anexos: Array.isArray(e.anexos) && e.anexos.length ? db.paraJson(e.anexos) : null
  });
}

/* ==========================================================================
   AUDITORIA
   ========================================================================== */

/**
 * `papel` não é coluna de auditoria: vem de um JOIN com contas. Conta excluída
 * perde o papel (o nome sobrevive em `autor`), então cai para 'sistema'.
 * O IP fica fora do payload de propósito — é dado pessoal e nenhuma tela usa.
 */
function auditoria(l) {
  return {
    id: l.id,
    quando: l.em,
    quandoTexto: dataHora(l.em),
    quem: l.autor || 'Sistema',
    papel: l.papel || 'sistema',
    area: l.area,
    alvo: l.alvo || '',
    acao: l.acao,
    detalhe: l.detalhe || ''
  };
}

/* ==========================================================================
   CONTAS
   ========================================================================== */

/** Conta do competidor logado, na forma que o painel espera em D.usuario(). */
function usuario(conta) {
  if (!conta) return null;
  return {
    id: conta.id,
    nome: conta.nome,
    email: conta.email,
    telefone: conta.telefone,
    papel: conta.papel,
    nivel: conta.nivel,
    emailVerificado: db.bool(conta.email_verificado),
    criadoEm: soData(conta.criado_em),
    ultimoAcessoEm: conta.ultimo_acesso_em
  };
}

/** Lista de administradores. Hash e sal de senha NUNCA entram aqui. */
function adminUsuario(conta) {
  return {
    id: conta.id,
    nome: conta.nome,
    email: conta.email,
    telefone: conta.telefone,
    nivel: conta.nivel,
    emailVerificado: db.bool(conta.email_verificado),
    senhaProvisoria: db.bool(conta.senha_provisoria),
    criadoEm: soData(conta.criado_em),
    ultimoAcessoEm: conta.ultimo_acesso_em,
    arquivado: Boolean(conta.arquivado_em),
    arquivadoEm: conta.arquivado_em
  };
}

/* ==========================================================================
   VARIÁVEIS DOS MODELOS DE E-MAIL

   Lista estática de documentação: alimenta a régua de variáveis da tela de
   modelos. Não é dado de banco, é o contrato de substituição no envio.
   ========================================================================== */

const VARIAVEIS_EMAIL = [
  { grupo: 'Usuário', itens: [
    { chave: '{{usuario.nome}}', desc: 'Nome do responsável ou atleta' },
    { chave: '{{usuario.email}}', desc: 'E-mail cadastrado' },
    { chave: '{{usuario.telefone}}', desc: 'Telefone cadastrado' }
  ]},
  { grupo: 'Time', itens: [
    { chave: '{{time.nome}}', desc: 'Nome do time' },
    { chave: '{{time.modalidade}}', desc: 'Modalidade do time' },
    { chave: '{{time.jogadores}}', desc: 'Quantidade de jogadores inscritos' }
  ]},
  { grupo: 'Campeonato', itens: [
    { chave: '{{campeonato.nome}}', desc: 'Nome do campeonato' },
    { chave: '{{campeonato.data}}', desc: 'Data de realização' },
    { chave: '{{campeonato.local}}', desc: 'Local' },
    { chave: '{{campeonato.encerramento}}', desc: 'Data de encerramento das inscrições' },
    { chave: '{{campeonato.vagas}}', desc: 'Total de vagas' },
    { chave: '{{campeonato.inscritos}}', desc: 'Total de inscritos' },
    { chave: '{{campeonato.oficial}}', desc: 'Times na lista oficial' },
    { chave: '{{campeonato.espera}}', desc: 'Times na lista de espera' }
  ]},
  { grupo: 'Inscrição e chamado', itens: [
    { chave: '{{inscricao.protocolo}}', desc: 'Número de protocolo da inscrição' },
    { chave: '{{inscricao.status}}', desc: 'Triagem, oficial ou espera' },
    { chave: '{{chamado.protocolo}}', desc: 'Protocolo do chamado' },
    { chave: '{{chamado.assunto}}', desc: 'Assunto do chamado' },
    { chave: '{{chamado.status}}', desc: 'Status atual do chamado' }
  ]},
  { grupo: 'Gerais', itens: [
    { chave: '{{codigo}}', desc: 'Código de verificação de 6 dígitos' },
    { chave: '{{data}}', desc: 'Data e hora do envio' },
    { chave: '{{smtp.servidor}}', desc: 'Servidor de saída configurado' }
  ]}
];

module.exports = {
  soData, dataHora, horaLegivel, lista,

  campeonato, paraLinhaCampeonato,
  time, paraLinhaTime,
  jogador, paraLinhaJogador,
  staff, paraLinhaStaff,
  documento, paraLinhaDocumento,
  inscricao, paraLinhaInscricao,
  chamado, chamadoAdmin, mensagem, paraLinhaChamado, paraLinhaMensagem,
  rankingLinha, rankingPorModalidade,
  rankingConfigLinha, rankingConfigPorModalidade, paraLinhaRankingConfig,
  RANKING_CONFIG_PADRAO,
  resultado, paraLinhaResultado,
  post, paraLinhaPost,
  evento, parceiro, categoria, paraLinhaCategoria,
  banner, paraLinhaBanner,
  bannerSite, paraLinhaBannerSite,
  smtp, paraLinhaSmtp,
  modeloEmail, paraLinhaModeloEmail,
  emailEnviado, paraLinhaEmailEnviado,
  auditoria,
  usuario, adminUsuario,
  VARIAVEIS_EMAIL
};
