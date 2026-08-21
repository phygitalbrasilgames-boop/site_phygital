/* ==========================================================================
   PHYGITAL BRASIL — REGRAS DE DOMÍNIO

   As regras do briefing que o servidor precisa impor. Estavam só no front-end,
   onde qualquer usuário podia contorná-las pelo console do navegador. Aqui elas
   passam a valer de verdade.

   Este arquivo é a fonte única de verdade das regras de elenco no servidor. O
   front-end tem a própria cópia em site/assets/js/dados.js para funcionar em
   modo estático; quando fala com a API, /api/bootstrap devolve estas regras e
   o front-end substitui as dele pelas do servidor, então as duas não divergem.
   ========================================================================== */
'use strict';

const db = require('./db');
const { erro400, erro403, erro404, erro409 } = require('./http');

/* --------------------------------------------------------------------------
   MODALIDADES — briefing, páginas 3 a 6
   -------------------------------------------------------------------------- */

const MODALIDADES = {
  futebol: {
    id: 'futebol', nome: 'Phygital Futebol', curto: 'Futebol', cor: '#009B4A',
    jogadoresMin: 6, jogadoresMax: 8, reservasMax: 3, staffMax: 3,
    staffRotulo: 'Treinador + 2 da comissão técnica ou mídia',
    temCategoria: true, temNumeroCamisa: true, temFuncao: true, temSteam: false,
    categorias: ['Sub 16', 'Sub 17', 'Sub 18', 'Amador', 'Profissional'],
    descricao: 'Partidas que começam no digital e terminam no gramado. Duas metades, um só placar.'
  },
  basquete: {
    id: 'basquete', nome: 'Phygital Basquete', curto: 'Basquete', cor: '#DF9911',
    jogadoresMin: 3, jogadoresMax: 4, reservasMax: 2, staffMax: 2,
    staffRotulo: 'Treinador + 1 da comissão técnica',
    temCategoria: false, temNumeroCamisa: true, temFuncao: false, temSteam: false,
    categorias: [],
    descricao: '3x3 na quadra e no console. Ritmo curto, decisão rápida, virada até o último lance.'
  },
  shooter: {
    id: 'shooter', nome: 'Phygital Shooter', curto: 'Shooter', cor: '#0A66B1',
    jogadoresMin: 5, jogadoresMax: 5, reservasMax: 3, staffMax: 1,
    staffRotulo: 'Treinador',
    temCategoria: false, temNumeroCamisa: false, temFuncao: false, temSteam: true,
    categorias: [],
    descricao: 'Cinco no servidor, cinco na arena. Precisão digital validada no confronto físico.'
  },
  dance: {
    id: 'dance', nome: 'Phygital Dance', curto: 'Dance', cor: '#FCE001',
    jogadoresMin: 1, jogadoresMax: 1, reservasMax: 0, staffMax: 1,
    staffRotulo: 'Staff (opcional)',
    temCategoria: false, temNumeroCamisa: false, temFuncao: false, temSteam: false,
    individual: true, staffOpcional: true, categorias: [],
    descricao: 'Atleta solo. Coreografia julgada por precisão de movimento e execução em pista.'
  },
  outros: {
    id: 'outros', nome: 'Outras Modalidades', curto: 'Outros', cor: '#6E7377',
    jogadoresMin: 1, jogadoresMax: 12, reservasMax: 3, staffMax: 3,
    staffRotulo: 'Comissão',
    temCategoria: false, temNumeroCamisa: false, temFuncao: false, temSteam: false,
    categorias: [],
    descricao: 'Novas disputas que a Phygital Brasil leva à arena. Formato definido por edital.'
  }
};

const modalidade = (id) => MODALIDADES[id] || MODALIDADES.outros;

/* --------------------------------------------------------------------------
   STATUS
   -------------------------------------------------------------------------- */

const STATUS_INSCRICAO = {
  triagem:   { id: 'triagem',   rotulo: 'Em triagem',      classe: 'tag--amarela' },
  oficial:   { id: 'oficial',   rotulo: 'Lista oficial',   classe: 'tag--verde' },
  espera:    { id: 'espera',    rotulo: 'Lista de espera', classe: 'tag--azul' },
  cancelada: { id: 'cancelada', rotulo: 'Cancelada',       classe: 'tag--erro' }
};

const STATUS_CHAMADO = {
  aberto:     { id: 'aberto',     rotulo: 'Aberto',       classe: 'tag--amarela' },
  andamento:  { id: 'andamento',  rotulo: 'Em andamento', classe: 'tag--azul' },
  respondido: { id: 'respondido', rotulo: 'Respondido',   classe: 'tag--verde' },
  encerrado:  { id: 'encerrado',  rotulo: 'Encerrado',    classe: 'tag--cinza' }
};

const STATUS_CAMPEONATO = {
  rascunho:   { id: 'rascunho',   rotulo: 'Rascunho',              classe: 'tag--cinza' },
  inscricoes: { id: 'inscricoes', rotulo: 'Inscrições abertas',    classe: 'tag--verde' },
  fechado:    { id: 'fechado',    rotulo: 'Inscrições encerradas', classe: 'tag--amarela' },
  andamento:  { id: 'andamento',  rotulo: 'Em andamento',          classe: 'tag--azul' },
  encerrado:  { id: 'encerrado',  rotulo: 'Encerrado',             classe: 'tag--cinza' }
};

const TIPOS_DOCUMENTO = {
  identidade: {
    id: 'identidade', nome: 'Documento de identidade',
    descricao: 'RG, CNH ou passaporte com foto legível.',
    obrigatorio: true, temValidade: true
  },
  imagem: {
    id: 'imagem', nome: 'Autorização de uso de imagem',
    descricao: 'Assinada pelo atleta ou pelo responsável legal.',
    obrigatorio: true, temValidade: false
  },
  responsavel: {
    id: 'responsavel', nome: 'Autorização do responsável',
    descricao: 'Obrigatória para atletas menores de 18 anos.',
    obrigatorio: false, temValidade: false, apenasMenores: true
  },
  aptidao: {
    id: 'aptidao', nome: 'Atestado de aptidão física',
    descricao: 'Emitido nos últimos 12 meses.',
    obrigatorio: true, temValidade: true
  }
};

const STATUS_DOCUMENTO = {
  pendente: { id: 'pendente', rotulo: 'Não enviado',    classe: 'tag--cinza' },
  enviado:  { id: 'enviado',  rotulo: 'Em conferência', classe: 'tag--amarela' },
  aprovado: { id: 'aprovado', rotulo: 'Aprovado',       classe: 'tag--verde' },
  recusado: { id: 'recusado', rotulo: 'Recusado',       classe: 'tag--erro' },
  vencido:  { id: 'vencido',  rotulo: 'Vencido',        classe: 'tag--erro' }
};

/* --------------------------------------------------------------------------
   ELENCO

   Mesma assinatura do front-end: recebe CONTAGENS, não listas.
   -------------------------------------------------------------------------- */

function validarElenco(modalidadeId, titulares, reservas) {
  const m = modalidade(modalidadeId);
  const erros = [];

  const t = Number(titulares) || 0;
  const r = Number(reservas) || 0;

  if (t < m.jogadoresMin) {
    erros.push(`Cadastre no mínimo ${m.jogadoresMin} jogador(es). Faltam ${m.jogadoresMin - t}.`);
  }
  if (t > m.jogadoresMax) {
    erros.push(`O máximo para ${m.curto} é ${m.jogadoresMax} jogador(es).`);
  }
  if (r > m.reservasMax) {
    erros.push(`O máximo de reservas para ${m.curto} é ${m.reservasMax}.`);
  }

  return { valido: erros.length === 0, erros };
}

/** Conta o elenco a partir do banco e valida. */
function validarElencoDoTime(timeId) {
  const time = db.um('SELECT * FROM times WHERE id = ?', timeId);
  if (!time) throw erro404('Time não encontrado.');

  const t = db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ? AND reserva = 0', timeId);
  const r = db.valor('SELECT COUNT(*) FROM jogadores WHERE time_id = ? AND reserva = 1', timeId);

  return { ...validarElenco(time.modalidade, t, r), titulares: t, reservas: r };
}

/** Campos exigidos por modalidade, conforme o briefing. */
function validarJogador(modalidadeId, jogador) {
  const m = modalidade(modalidadeId);
  const erros = [];

  if (!String(jogador.nome || '').trim()) erros.push('O nome do jogador é obrigatório.');

  if (m.temSteam) {
    /* Steam64 é sempre 17 dígitos começando em 7656119. */
    if (!/^7656119\d{10}$/.test(String(jogador.steam || '').trim())) {
      erros.push('Steam64 ID inválido — são 17 dígitos começando por 7656119.');
    }
    /* Aceita com e sem subdomínio: faceit.com/... e www.faceit.com/... */
    if (!/^https?:\/\/([\w-]+\.)*faceit\.com\/.+/i.test(String(jogador.faceit || '').trim())) {
      erros.push('Informe a URL completa do perfil Faceit.');
    }
  }

  if (jogador.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(jogador.email).trim())) {
    erros.push(`E-mail inválido para ${jogador.nome || 'o jogador'}.`);
  }

  return { valido: erros.length === 0, erros };
}

/* --------------------------------------------------------------------------
   TRAVA DE EDIÇÃO

   Regra transversal do briefing: o competidor edita livremente até a data de
   encerramento das inscrições do campeonato. Depois disso, só por chamado.

   Vale para QUALQUER escrita no time que esteja inscrito num campeonato já
   fechado — não é checagem de tela, é regra de negócio.
   -------------------------------------------------------------------------- */

function travasDoTime(timeId) {
  const linhas = db.todos(
    `SELECT c.id, c.nome, c.encerramento_inscricoes, c.status, i.protocolo, i.status AS inscricao
       FROM inscricoes i
       JOIN campeonatos c ON c.id = i.campeonato_id
      WHERE i.time_id = ? AND i.status != 'cancelada'`,
    timeId
  );

  const hoje = new Date().toISOString().slice(0, 10);

  return linhas
    .filter((l) => {
      /* Trava se o prazo passou ou se o campeonato já saiu da fase de inscrição. */
      const prazoPassou = l.encerramento_inscricoes && l.encerramento_inscricoes < hoje;
      const faseFechada = ['fechado', 'andamento', 'encerrado'].includes(l.status);
      return prazoPassou || faseFechada;
    })
    .map((l) => ({
      campeonato: l.id,
      nome: l.nome,
      protocolo: l.protocolo,
      encerramento: l.encerramento_inscricoes
    }));
}

function edicaoLiberada(timeId) {
  return travasDoTime(timeId).length === 0;
}

/**
 * Barra a escrita quando o time está travado. `permitirPorChamado` libera a
 * alteração que o admin aprovou via chamado.
 */
function exigirEdicaoLiberada(timeId, { permitirPorChamado = false } = {}) {
  if (permitirPorChamado) return;

  const travas = travasDoTime(timeId);
  if (!travas.length) return;

  const nomes = travas.map((t) => t.nome).join(', ');
  throw erro409(
    `As inscrições já foram encerradas em: ${nomes}. Qualquer alteração agora precisa passar por um chamado.`,
    { travas, exigeChamado: true }
  );
}

/* --------------------------------------------------------------------------
   CICLO DE VIDA DO CAMPEONATO

   Criar → Publicar → Iniciar → Encerrar → Apurar → Encerrado.
   -------------------------------------------------------------------------- */

const TRANSICOES = {
  rascunho:   ['inscricoes'],
  inscricoes: ['fechado', 'rascunho'],
  fechado:    ['andamento', 'inscricoes'],
  andamento:  ['encerrado'],
  encerrado:  []
};

function podeTransicionar(de, para) {
  return (TRANSICOES[de] || []).includes(para);
}

function exigirTransicao(de, para) {
  if (!STATUS_CAMPEONATO[para]) throw erro400(`Status desconhecido: ${para}.`);
  if (de === para) return;
  if (!podeTransicionar(de, para)) {
    const possiveis = (TRANSICOES[de] || []).map((s) => STATUS_CAMPEONATO[s].rotulo).join(', ') || 'nenhuma';
    throw erro409(
      `Não é possível ir de "${STATUS_CAMPEONATO[de].rotulo}" para "${STATUS_CAMPEONATO[para].rotulo}". ` +
      `Transições possíveis: ${possiveis}.`
    );
  }
}

/** Um campeonato só aceita inscrição com status 'inscricoes' e dentro do prazo. */
function inscricaoAberta(campeonato) {
  if (campeonato.status !== 'inscricoes') return { aberta: false, motivo: 'As inscrições não estão abertas.' };

  const hoje = new Date().toISOString().slice(0, 10);
  if (campeonato.abertura_inscricoes && campeonato.abertura_inscricoes > hoje) {
    return { aberta: false, motivo: `As inscrições abrem em ${campeonato.abertura_inscricoes}.` };
  }
  if (campeonato.encerramento_inscricoes && campeonato.encerramento_inscricoes < hoje) {
    return { aberta: false, motivo: `As inscrições encerraram em ${campeonato.encerramento_inscricoes}.` };
  }
  return { aberta: true };
}

/* --------------------------------------------------------------------------
   PROTOCOLOS

   Formato do briefing: AAAA-NNNNNN, sequencial por ano. Gerado dentro da
   transação de quem chama, então dois pedidos simultâneos não colidem.
   -------------------------------------------------------------------------- */

function proximoProtocolo(tabela) {
  const ano = new Date().getFullYear();
  const prefixo = `${ano}-`;

  const ultimo = db.valor(
    `SELECT protocolo FROM ${tabela}
      WHERE protocolo LIKE ? ORDER BY protocolo DESC LIMIT 1`,
    `${prefixo}%`
  );

  const sequencia = ultimo ? Number(String(ultimo).slice(prefixo.length)) + 1 : 1;
  return prefixo + String(sequencia).padStart(6, '0');
}

/* --------------------------------------------------------------------------
   DOCUMENTOS
   -------------------------------------------------------------------------- */

/** 'vencido' é derivado da validade, nunca gravado. */
function statusDocumento(doc) {
  if (!doc || !doc.arquivo) return 'pendente';
  if (doc.status === 'aprovado' && doc.validade) {
    const hoje = new Date().toISOString().slice(0, 10);
    if (doc.validade < hoje) return 'vencido';
  }
  return doc.status;
}

function documentosExigidos(jogador) {
  const exigidos = Object.values(TIPOS_DOCUMENTO).filter((t) => t.obrigatorio);

  /* Menor de 18 na data de hoje também precisa da autorização do responsável. */
  if (jogador && jogador.nasc) {
    const nasc = new Date(jogador.nasc);
    const idade = (Date.now() - nasc.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (idade < 18) exigidos.push(TIPOS_DOCUMENTO.responsavel);
  }

  return exigidos;
}

/* --------------------------------------------------------------------------
   AUDITORIA
   -------------------------------------------------------------------------- */

function registrar(ctx, area, alvo, acao, detalhe) {
  const conta = ctx && ctx._conta !== undefined ? ctx._conta : (ctx && ctx.conta);
  db.executar(
    `INSERT INTO auditoria (area, alvo, acao, detalhe, conta_id, autor, ip, em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    area, alvo || null, acao, detalhe || null,
    conta ? conta.id : null, conta ? conta.nome : 'sistema',
    ctx ? ctx.ip : null, db.agora()
  );
}

module.exports = {
  MODALIDADES, modalidade,
  STATUS_INSCRICAO, STATUS_CHAMADO, STATUS_CAMPEONATO,
  TIPOS_DOCUMENTO, STATUS_DOCUMENTO,
  validarElenco, validarElencoDoTime, validarJogador,
  travasDoTime, edicaoLiberada, exigirEdicaoLiberada,
  TRANSICOES, podeTransicionar, exigirTransicao, inscricaoAberta,
  proximoProtocolo,
  statusDocumento, documentosExigidos,
  registrar
};
