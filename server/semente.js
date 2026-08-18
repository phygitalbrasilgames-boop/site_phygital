/* ==========================================================================
   PHYGITAL BRASIL — SEMENTE DE DEMONSTRAÇÃO

   Popula o banco com os mesmos dados que o protótipo mantinha em
   localStorage (Backup_html/assets/js/dados.js), agora normalizados no
   esquema relacional.

   Uso:
     node server/semente.js              semeia o que estiver faltando
     node server/semente.js --recriar    apaga o conteúdo de todas as tabelas
                                         antes de popular (o arquivo do banco
                                         é preservado)

   Decisões que valem explicar:

   · IDEMPOTÊNCIA — toda inserção passa por `inserir()`, que primeiro procura a
     linha pela chave de negócio. Rodar a semente duas vezes não duplica nada,
     então ela pode ficar no start do servidor sem risco.

   · FORMATO DAS DATAS — os campos que o front-end exibe (ou joga dentro de um
     <input type="date">) guardam exatamente a string da semente: 'AAAA-MM-DD'
     é ISO 8601 válido, ordena certo como texto e continua funcionando nas
     telas, que em alguns pontos concatenam 'T00:00:00' na string. Só os campos
     que ninguém exibe recebem instante completo.

   · SENHAS — nenhuma senha literal neste arquivo. As duas contas de acesso leem
     PHYGITAL_ADMIN_SENHA e PHYGITAL_COMPETIDOR_SENHA; na ausência delas, e para
     os administradores u2/u3, a senha é sorteada com node:crypto, impressa uma
     única vez e a conta fica marcada com senha_provisoria = 1. A senha do SMTP
     não vai para o banco (o esquema não tem a coluna): vem de
     PHYGITAL_SMTP_SENHA no momento do envio.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const regras = require('./regras');

/* --------------------------------------------------------------------------
   CONTAS DE ACESSO

   u1 é a mesma conta master do painel administrativo — a lista de usuários do
   protótipo repetia esse e-mail, e aqui ele existe uma única vez.
   -------------------------------------------------------------------------- */

const EMAIL_ADMIN = 'inscricoes@phygitalgamesbr.com.br';
const EMAIL_COMPETIDOR = 'phygitalbrasilgames@gmail.com';

/* O protótipo não dava id para a conta do competidor (só existia um "usuario"
   solto); os times da semente passam a apontar para este. */
const ID_COMPETIDOR = 'comp1';

const ADMINISTRADORES = [
  { id: 'u1', nome: 'Inscrições Phygital', email: EMAIL_ADMIN,
    telefone: '(11) 3000-0001', nivel: 'master', criadoEm: '2026-01-10',
    variavelSenha: 'PHYGITAL_ADMIN_SENHA', emailVerificado: true },
  { id: 'u2', nome: 'Ana Beatriz Lopes', email: 'ana@phygitalgamesbr.com.br',
    telefone: '(11) 3000-0002', nivel: 'gestor', criadoEm: '2026-03-22',
    variavelSenha: null, emailVerificado: false },
  { id: 'u3', nome: 'Carlos Eduardo Pinto', email: 'carlos@phygitalgamesbr.com.br',
    telefone: '(11) 3000-0003', nivel: 'operacao', criadoEm: '2026-05-08',
    variavelSenha: null, emailVerificado: false }
];

/* Dados que o protótipo guardava no objeto `usuario`. Nome e e-mail cedem lugar
   à conta de acesso pedida para o competidor; telefone e data de criação são
   aproveitados. */
const COMPETIDOR = {
  id: ID_COMPETIDOR,
  nome: 'Phygital Brasil Games',
  email: EMAIL_COMPETIDOR,
  telefone: '(11) 98877-6655',
  criadoEm: '2026-07-02',
  variavelSenha: 'PHYGITAL_COMPETIDOR_SENHA'
};

/* --------------------------------------------------------------------------
   CAMPEONATOS
   -------------------------------------------------------------------------- */

const CAMPEONATOS = [
  {
    id: 'cbf-2026',
    nome: 'Copa Phygital Futebol 2026 — Etapa Nacional',
    modalidade: 'futebol',
    banner: 'assets/img/mock/camp-futebol.svg',
    vagas: 24,
    jogadoresMin: 6, jogadoresMax: 8, reservas: true, staffMax: 3,
    data: '2026-09-19', dataFim: '2026-09-21',
    local: 'Arena Phygital — São Paulo, SP',
    aberturaInscricoes: '2026-08-01',
    encerramentoInscricoes: '2026-09-05',
    descricao: 'A principal etapa do calendário nacional. 24 times disputam vaga direta na seletiva do Games of the Future.',
    premiacao: { tipo: 'dinheiro', total: 60000, colocacoes: [
      { pos: 1, valor: 30000 }, { pos: 2, valor: 18000 }, { pos: 3, valor: 12000 }
    ] },
    termos: 'Ao inscrever o time o responsável declara que todos os atletas possuem autorização de imagem e estão aptos fisicamente à disputa.',
    regulamento: 'regulamento-copa-futebol-2026.pdf',
    status: 'inscricoes'
  },
  {
    id: 'cbb-2026',
    nome: 'Circuito Phygital Basquete 3x3 — 2ª Edição',
    modalidade: 'basquete',
    banner: 'assets/img/mock/camp-basquete.svg',
    vagas: 16,
    jogadoresMin: 3, jogadoresMax: 4, reservas: true, staffMax: 2,
    data: '2026-10-11', dataFim: '2026-10-12',
    local: 'Ginásio Poliesportivo — Belo Horizonte, MG',
    aberturaInscricoes: '2026-08-10',
    encerramentoInscricoes: '2026-09-28',
    descricao: 'Formato 3x3 com rodadas simultâneas no console e na quadra. Classificação por saldo combinado.',
    premiacao: { tipo: 'outro', descricao: 'Kit completo de material esportivo + vaga na etapa nacional' },
    termos: 'O time se compromete a comparecer com o elenco inscrito. Substituições após o encerramento das inscrições só por chamado.',
    regulamento: 'regulamento-basquete-3x3.pdf',
    status: 'inscricoes'
  },
  {
    id: 'cbs-2026',
    nome: 'Phygital Shooter Open — Temporada 2026',
    modalidade: 'shooter',
    banner: 'assets/img/mock/camp-shooter.svg',
    vagas: 20,
    jogadoresMin: 5, jogadoresMax: 5, reservas: true, staffMax: 1,
    data: '2026-11-07', dataFim: '2026-11-09',
    local: 'Centro de Convenções — Curitiba, PR',
    aberturaInscricoes: '2026-09-01',
    encerramentoInscricoes: '2026-10-20',
    descricao: 'Cinco rodadas classificatórias no servidor oficial e final presencial com prova física de desempate.',
    premiacao: { tipo: 'dinheiro', total: 40000, colocacoes: [
      { pos: 1, valor: 22000 }, { pos: 2, valor: 12000 }, { pos: 3, valor: 6000 }
    ] },
    termos: 'Obrigatório informar Steam64 e perfil Faceit válidos. Contas com banimento ativo serão desclassificadas.',
    regulamento: 'regulamento-shooter-open.pdf',
    status: 'inscricoes'
  },
  {
    id: 'cbd-2025',
    nome: 'Phygital Dance Championship 2025',
    modalidade: 'dance',
    banner: 'assets/img/mock/camp-dance.svg',
    vagas: 40,
    jogadoresMin: 1, jogadoresMax: 1, reservas: false, staffMax: 1,
    data: '2025-11-22', dataFim: '2025-11-23',
    local: 'Teatro Municipal — Recife, PE',
    aberturaInscricoes: '2025-09-01',
    encerramentoInscricoes: '2025-10-30',
    descricao: 'Disputa individual com julgamento por precisão de movimento, sincronia e execução em pista.',
    premiacao: { tipo: 'dinheiro', total: 15000, colocacoes: [
      { pos: 1, valor: 8000 }, { pos: 2, valor: 4000 }, { pos: 3, valor: 3000 }
    ] },
    termos: 'Atleta individual. Staff opcional.',
    regulamento: 'regulamento-dance-2025.pdf',
    status: 'encerrado',
    classificacao: [
      { pos: 1, nome: 'Marina Duarte', uf: 'PE' },
      { pos: 2, nome: 'Yasmin Rocha', uf: 'SP' },
      { pos: 3, nome: 'Letícia Alves', uf: 'RJ' }
    ]
  },
  {
    id: 'cbf-2025',
    nome: 'Copa Phygital Futebol 2025',
    modalidade: 'futebol',
    banner: 'assets/img/mock/camp-futebol-2.svg',
    vagas: 20,
    data: '2025-09-20', dataFim: '2025-09-22',
    local: 'Arena Phygital — São Paulo, SP',
    aberturaInscricoes: '2025-07-15',
    encerramentoInscricoes: '2025-09-01',
    descricao: 'Primeira edição nacional do formato phygital de futebol no Brasil.',
    status: 'encerrado',
    classificacao: [
      { pos: 1, nome: 'Tigres Phygital', uf: 'SP' },
      { pos: 2, nome: 'Fúria Digital', uf: 'RJ' },
      { pos: 3, nome: 'Leões do Cerrado', uf: 'DF' }
    ]
  }
];

/* Placar phygital: cada confronto soma a metade digital com a metade física. */
const RESULTADOS = [
  { data: '2025-09-22', mod: 'futebol', camp: 'Copa Phygital Futebol 2025', local: 'São Paulo, SP', fase: 'Final',
    casa: { nome: 'Tigres Phygital', escudo: 1, digital: 3, fisico: 2 },
    fora: { nome: 'Fúria Digital', escudo: 2, digital: 2, fisico: 2 } },
  { data: '2025-09-22', mod: 'futebol', camp: 'Copa Phygital Futebol 2025', local: 'São Paulo, SP', fase: 'Semifinal',
    casa: { nome: 'Leões do Cerrado', escudo: 3, digital: 2, fisico: 3 },
    fora: { nome: 'Vendaval FC', escudo: 4, digital: 3, fisico: 1 } },
  { data: '2025-11-23', mod: 'basquete', camp: 'Circuito Basquete 3x3', local: 'Belo Horizonte, MG', fase: 'Final',
    casa: { nome: 'Cangaço 3x3', escudo: 5, digital: 21, fisico: 18 },
    fora: { nome: 'Bulls Phygital', escudo: 6, digital: 17, fisico: 19 } },
  { data: '2025-10-05', mod: 'shooter', camp: 'Shooter Open 2025', local: 'Porto Alegre, RS', fase: 'Final',
    casa: { nome: 'Alpha Squad BR', escudo: 9, digital: 13, fisico: 8 },
    fora: { nome: 'Onça Preta e-Sports', escudo: 10, digital: 11, fisico: 9 } }
];

/* A ordem de cada lista é a colocação no ranking: vira a coluna `posicao`. */
const RANKING = {
  futebol: [
    { nome: 'Tigres Phygital', uf: 'SP', v: 24, e: 4, d: 4, camp: 6, titulos: 3, gotf: true },
    { nome: 'Fúria Digital', uf: 'RJ', v: 21, e: 3, d: 7, camp: 6, titulos: 2, gotf: true },
    { nome: 'Leões do Cerrado', uf: 'DF', v: 18, e: 3, d: 9, camp: 5, titulos: 1, gotf: false },
    { nome: 'Vendaval FC', uf: 'RS', v: 16, e: 2, d: 10, camp: 5, titulos: 0, gotf: false },
    { nome: 'Atlético Pixel', uf: 'MG', v: 15, e: 2, d: 11, camp: 4, titulos: 0, gotf: true },
    { nome: 'Marés do Norte', uf: 'PA', v: 12, e: 2, d: 12, camp: 4, titulos: 0, gotf: false },
    { nome: 'Sertão United', uf: 'BA', v: 10, e: 1, d: 14, camp: 3, titulos: 0, gotf: false },
    { nome: 'Guarani Byte', uf: 'PR', v: 8, e: 1, d: 15, camp: 3, titulos: 0, gotf: false }
  ],
  basquete: [
    { nome: 'Cangaço 3x3', uf: 'PE', v: 19, e: 3, d: 3, camp: 4, titulos: 2, gotf: true },
    { nome: 'Bulls Phygital', uf: 'SP', v: 17, e: 2, d: 5, camp: 4, titulos: 1, gotf: false },
    { nome: 'Nova Era BC', uf: 'SC', v: 14, e: 2, d: 8, camp: 3, titulos: 0, gotf: false },
    { nome: 'Cruzeiro do Sul', uf: 'GO', v: 11, e: 1, d: 9, camp: 3, titulos: 0, gotf: false },
    { nome: 'Costa Verde', uf: 'RJ', v: 9, e: 1, d: 11, camp: 2, titulos: 0, gotf: false }
  ],
  shooter: [
    { nome: 'Alpha Squad BR', uf: 'SP', v: 31, e: 5, d: 9, camp: 5, titulos: 2, gotf: true },
    { nome: 'Onça Preta e-Sports', uf: 'MT', v: 28, e: 4, d: 12, camp: 5, titulos: 1, gotf: true },
    { nome: 'Zero Latency', uf: 'RS', v: 24, e: 4, d: 14, camp: 4, titulos: 1, gotf: false },
    { nome: 'Cerrado Force', uf: 'DF', v: 20, e: 3, d: 16, camp: 4, titulos: 0, gotf: false },
    { nome: 'Litoral Gaming', uf: 'SC', v: 17, e: 2, d: 18, camp: 3, titulos: 0, gotf: false }
  ],
  dance: [
    { nome: 'Marina Duarte', uf: 'PE', v: 14, e: 2, d: 2, camp: 4, titulos: 3, gotf: true },
    { nome: 'Yasmin Rocha', uf: 'SP', v: 12, e: 2, d: 4, camp: 4, titulos: 1, gotf: false },
    { nome: 'Letícia Alves', uf: 'RJ', v: 10, e: 1, d: 5, camp: 3, titulos: 0, gotf: true },
    { nome: 'Bruno Sampaio', uf: 'CE', v: 8, e: 1, d: 7, camp: 3, titulos: 0, gotf: false },
    { nome: 'Camila Nunes', uf: 'MG', v: 6, e: 1, d: 8, camp: 2, titulos: 0, gotf: false }
  ]
};

const RANKING_CONFIG = {
  futebol:  { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
  basquete: { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
  shooter:  { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
  dance:    { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true }
};

/* --------------------------------------------------------------------------
   CONTEÚDO PÚBLICO
   -------------------------------------------------------------------------- */

const CATEGORIAS = [
  { id: 'campeonatos', nome: 'Campeonatos', descricao: 'Aberturas, calendário e resultados das etapas.', cor: '#009B4A' },
  { id: 'regulamento', nome: 'Regulamento', descricao: 'Regras, formato de disputa e critérios de classificação.', cor: '#0A66B1' },
  { id: 'institucional', nome: 'Institucional', descricao: 'Notícias da Phygital Brasil e representação internacional.', cor: '#FCE001' },
  { id: 'inscricoes', nome: 'Inscrições', descricao: 'Prazos, documentação e orientações para responsáveis.', cor: '#DF9911' },
  { id: 'eventos', nome: 'Eventos', descricao: 'Cobertura e retrospectiva das etapas realizadas.', cor: '#3D93D6' }
];

/* `cat` guarda o NOME da categoria, como no protótipo — a busca do front-end
   aceita id ou nome, e trocar para o slug quebraria os posts existentes. */
const POSTS = [
  { id: 'p1', titulo: 'Copa Phygital Futebol 2026 abre inscrições para 24 times', cat: 'Campeonatos', data: '2026-08-01', autor: 'Redação Phygital', img: 'assets/img/mock/post-1.svg',
    resumo: 'A etapa nacional acontece em setembro, em São Paulo, com vaga direta na seletiva do Games of the Future para o campeão.' },
  { id: 'p2', titulo: 'Como funciona a pontuação combinada no formato phygital', cat: 'Regulamento', data: '2026-07-24', autor: 'Comitê Técnico', img: 'assets/img/mock/post-2.svg',
    resumo: 'Entenda como o resultado digital e o resultado físico se somam para definir o placar final de cada confronto.' },
  { id: 'p3', titulo: 'Brasil confirma delegação para o Games of the Future', cat: 'Institucional', data: '2026-07-10', autor: 'Redação Phygital', img: 'assets/img/mock/post-3.svg',
    resumo: 'Times campeões das quatro modalidades representam o país na competição internacional.' },
  { id: 'p4', titulo: 'Circuito de Basquete 3x3 chega a Belo Horizonte', cat: 'Campeonatos', data: '2026-06-28', autor: 'Redação Phygital', img: 'assets/img/mock/post-4.svg',
    resumo: 'Segunda edição do circuito amplia o número de vagas e estreia novo formato de classificação.' },
  { id: 'p5', titulo: 'Guia do responsável: erros que atrasam a inscrição do seu time', cat: 'Inscrições', data: '2026-06-12', autor: 'Central de Inscrições', img: 'assets/img/mock/post-5.svg',
    resumo: 'Foto fora do padrão, elenco incompleto e documento vencido são as três causas mais comuns de pendência.' },
  { id: 'p6', titulo: 'Dance Championship 2025: retrospectiva da final em Recife', cat: 'Eventos', data: '2025-11-25', autor: 'Redação Phygital', img: 'assets/img/mock/post-6.svg',
    resumo: 'Trinta e seis atletas, dois dias de disputa e uma final decidida por menos de um ponto.' }
];

const EVENTOS = [
  { id: 'e1', titulo: 'Copa Phygital Futebol 2025 — Final', mod: 'futebol', ano: 2025, local: 'São Paulo, SP', fotos: 42 },
  { id: 'e2', titulo: 'Dance Championship 2025', mod: 'dance', ano: 2025, local: 'Recife, PE', fotos: 38 },
  { id: 'e3', titulo: 'Shooter Open 2025 — Etapa Sul', mod: 'shooter', ano: 2025, local: 'Porto Alegre, RS', fotos: 27 },
  { id: 'e4', titulo: 'Circuito Basquete 3x3 — 1ª Edição', mod: 'basquete', ano: 2025, local: 'Belo Horizonte, MG', fotos: 31 },
  { id: 'e5', titulo: 'Seletiva Games of the Future', mod: 'futebol', ano: 2024, local: 'Brasília, DF', fotos: 55 },
  { id: 'e6', titulo: 'Phygital Experience — Feira', mod: 'outros', ano: 2024, local: 'São Paulo, SP', fotos: 19 }
];

/* O protótipo não dava id nem logo aos parceiros: a imagem saía do índice na
   lista. `ordem` preserva esse índice, então o logo de cada parceiro continua
   o mesmo na home e na página de parceiros. */
const PARCEIROS = [
  { nome: 'Ministério do Esporte', tipo: 'Apoio institucional' },
  { nome: 'Confederação Brasileira', tipo: 'Apoio institucional' },
  { nome: 'Arena Nacional', tipo: 'Sede oficial' },
  { nome: 'TechSports', tipo: 'Patrocinador master' },
  { nome: 'EnergyDrink BR', tipo: 'Patrocinador' },
  { nome: 'GearPro', tipo: 'Fornecedor oficial' },
  { nome: 'StreamHub', tipo: 'Transmissão' },
  { nome: 'Instituto Movimento', tipo: 'Projeto social' }
];

/* Banner do painel do competidor. */
const BANNERS = [
  { id: 'b1', titulo: 'Copa Phygital Futebol 2026', img: 'assets/img/mock/camp-futebol.svg', link: 'inscricoes.html', ordem: 1, ativo: true },
  { id: 'b2', titulo: 'Circuito Basquete 3x3', img: 'assets/img/mock/camp-basquete.svg', link: 'inscricoes.html', ordem: 2, ativo: true },
  { id: 'b3', titulo: 'Shooter Open — Temporada 2026', img: 'assets/img/mock/camp-shooter.svg', link: 'inscricoes.html', ordem: 3, ativo: true }
];

/* Banner do hero do site público. */
const BANNERS_SITE = [
  { id: 's1', titulo: 'O físico e o digital no mesmo campo de jogo',
    texto: 'Cada confronto tem duas metades: uma no console, outra na quadra. O placar final é a soma das duas. É assim que a Phygital Brasil disputa futebol, basquete, dance e shooter em todo o país.',
    eyebrow: 'Temporada 2026',
    botao: 'Ver inscrições abertas', link: 'inscricoes.html',
    botao2: 'Como funciona', link2: 'quem-somos.html',
    midia: 'imagem', img: 'assets/img/mock/hero-1.svg', video: '',
    tituloTamanho: 0, semTexto: false, ordem: 1, ativo: true },
  { id: 's2', titulo: 'Circuito Phygital Basquete 3x3',
    texto: 'Segunda edição do circuito, agora em Belo Horizonte, com 16 vagas e novo formato de classificação.',
    eyebrow: 'Inscrições abertas',
    botao: 'Inscrever time', link: 'inscricoes.html', botao2: '', link2: '',
    midia: 'imagem', img: 'assets/img/mock/hero-2.svg', video: '',
    tituloTamanho: 0, semTexto: false, ordem: 2, ativo: true },
  { id: 's3', titulo: '', texto: '', eyebrow: '',
    botao: '', link: '', botao2: '', link2: '',
    midia: 'imagem', img: 'assets/img/mock/hero-3.svg', video: '',
    tituloTamanho: 0, semTexto: true, ordem: 3, ativo: true }
];

/* --------------------------------------------------------------------------
   TIMES DO COMPETIDOR
   -------------------------------------------------------------------------- */

const TIMES = [
  {
    id: 't1', nome: 'Tigres Phygital', modalidade: 'futebol', categoria: 'Profissional',
    criadoEm: '2023-03-14', escudo: null,
    descricao: 'Time paulista fundado em 2023, tricampeão da Copa Phygital de Futebol.',
    historico: 'Campeão 2023, 2024 e 2025. Participação no Games of the Future 2025.',
    jogadores: [
      { nome: 'Rafael Antunes', apelido: 'Rafa', numero: 10, funcao: 'Meia', email: 'rafa@exemplo.com', tel: '(11) 91111-1111', nasc: '2001-04-12', insta: '@rafa10',
        documentos: [
          { tipo: 'identidade', arquivo: 'rg-rafael-antunes.pdf', validade: '2030-04-12', status: 'aprovado' },
          { tipo: 'imagem', arquivo: 'autorizacao-imagem-rafael.pdf', status: 'aprovado' },
          { tipo: 'aptidao', arquivo: 'atestado-rafael.pdf', validade: '2027-02-10', status: 'aprovado' }
        ] },
      { nome: 'Bruno Carvalho', apelido: 'Bruninho', numero: 7, funcao: 'Atacante', email: 'bruno@exemplo.com', tel: '(11) 92222-2222', nasc: '2002-08-03', insta: '@brunoc',
        documentos: [
          { tipo: 'identidade', arquivo: 'rg-bruno-carvalho.pdf', validade: '2029-08-03', status: 'aprovado' },
          { tipo: 'imagem', arquivo: 'autorizacao-imagem-bruno.pdf', status: 'enviado' },
          /* Validade no passado: statusDocumento() deriva "vencido" na leitura. */
          { tipo: 'aptidao', arquivo: 'atestado-bruno.pdf', validade: '2025-06-01', status: 'aprovado' }
        ] },
      { nome: 'Lucas Prado', apelido: 'Prado', numero: 1, funcao: 'Goleiro', email: 'lucas@exemplo.com', tel: '(11) 93333-3333', nasc: '2000-01-27', insta: '@pradogk',
        documentos: [
          { tipo: 'identidade', arquivo: 'cnh-lucas-prado.pdf', validade: '2028-01-27', status: 'aprovado' },
          { tipo: 'imagem', arquivo: 'autorizacao-imagem-lucas.pdf', status: 'recusado', observacao: 'Assinatura ilegível — reenviar com a via assinada em azul.' }
        ] },
      { nome: 'Igor Menezes', apelido: 'Igão', numero: 4, funcao: 'Zagueiro', email: 'igor@exemplo.com', tel: '(11) 94444-4444', nasc: '1999-11-09', insta: '@igao4' },
      { nome: 'Thiago Lima', apelido: 'TL', numero: 8, funcao: 'Volante', email: 'thiago@exemplo.com', tel: '(11) 95555-5555', nasc: '2003-06-21', insta: '@tl8' },
      { nome: 'Wesley Dias', apelido: 'Wes', numero: 11, funcao: 'Ponta', email: 'wesley@exemplo.com', tel: '(11) 96666-6666', nasc: '2002-02-14', insta: '@wesd' },
      { nome: 'Caio Ferreira', apelido: 'Caio', numero: 15, funcao: 'Lateral', email: 'caio@exemplo.com', tel: '(11) 97777-7777', nasc: '2004-09-30', insta: '@caiof', reserva: true }
    ],
    staff: [
      { nome: 'Marcelo Rangel', papel: 'Treinador', email: 'marcelo@exemplo.com', tel: '(11) 90000-0001', nasc: '1980-05-02', insta: '@rangel' },
      { nome: 'Paula Cruz', papel: 'Preparadora física', email: 'paula@exemplo.com', tel: '(11) 90000-0002', nasc: '1988-12-11', insta: '@paulacruz' }
    ]
  },
  {
    id: 't2', nome: 'Alpha Squad BR', modalidade: 'shooter', categoria: null,
    criadoEm: '2024-01-20', escudo: null,
    descricao: 'Equipe de shooter competitivo com foco em disputas phygital.',
    historico: 'Vice-campeã do Shooter Open 2025.',
    jogadores: [
      { nome: 'Pedro Nogueira', apelido: 'p3dro', steam: '76561198000000001', faceit: 'https://faceit.com/br/players/p3dro', email: 'pedro@exemplo.com', tel: '(11) 98000-0001', nasc: '2001-03-05', insta: '@p3dro' },
      { nome: 'Vitor Hugo', apelido: 'vhz', steam: '76561198000000002', faceit: 'https://faceit.com/br/players/vhz', email: 'vitor@exemplo.com', tel: '(11) 98000-0002', nasc: '2000-07-19', insta: '@vhz' },
      { nome: 'Danilo Souza', apelido: 'dan1', steam: '76561198000000003', faceit: 'https://faceit.com/br/players/dan1', email: 'danilo@exemplo.com', tel: '(11) 98000-0003', nasc: '2002-10-02', insta: '@dan1' },
      { nome: 'Gabriel Reis', apelido: 'gabz', steam: '76561198000000004', faceit: 'https://faceit.com/br/players/gabz', email: 'gabriel@exemplo.com', tel: '(11) 98000-0004', nasc: '2003-05-23', insta: '@gabz' },
      { nome: 'Enzo Martins', apelido: 'enz0', steam: '76561198000000005', faceit: 'https://faceit.com/br/players/enz0', email: 'enzo@exemplo.com', tel: '(11) 98000-0005', nasc: '2004-01-08', insta: '@enz0' }
    ],
    staff: [
      { nome: 'Ricardo Alves', papel: 'Treinador', email: 'ricardo@exemplo.com', tel: '(11) 98000-0100', nasc: '1985-09-14', insta: '@ricardoalves' }
    ]
  }
];

const INSCRICOES = [
  { id: 'i1', campeonato: 'cbf-2026', time: 't1', protocolo: '2026-000418', status: 'oficial', data: '2026-08-03' },
  { id: 'i2', campeonato: 'cbs-2026', time: 't2', protocolo: '2026-000512', status: 'triagem', data: '2026-08-11' }
];

/* --------------------------------------------------------------------------
   CHAMADOS

   O protótipo mantinha duas listas (`chamados`, do competidor, e
   `adminChamados`, da organização) e o MESMO chamado aparecia nas duas — a1 é
   c1 e a5 é c2. Aqui o protocolo é UNIQUE e o chamado é uma linha só: c1 e c2
   entram com a conversa completa e o time vinculado que só a lista do admin
   informava; de adminChamados sobram a2, a3 e a4.

   a2, a3 e a4 são de times que não existem em `times` (pertencem a outros
   responsáveis, que a semente não cria): time_id fica nulo e o nome do time,
   única identificação que a semente traz do solicitante, vai para `autor`.
   -------------------------------------------------------------------------- */

const CHAMADOS = [
  {
    id: 'c1', protocolo: '2026-000091',
    assunto: 'Troca de jogador após encerramento das inscrições',
    campeonato: 'cbf-2026', time: 't1', doCompetidor: true,
    status: 'respondido', autor: 'Diego Martins',
    abertoEm: '2026-08-09', atualizadoEm: '2026-08-12',
    mensagens: [
      { de: 'usuario', autor: 'Diego Martins', texto: 'Preciso substituir o jogador Caio Ferreira por lesão. Já tenho o substituto cadastrado.', hora: '09/08/2026 14:22' },
      { de: 'sistema', autor: null, texto: 'Chamado recebido — protocolo 2026-000091. Status: Aberto.', hora: '09/08/2026 14:22' },
      { de: 'org', autor: 'Organização Phygital', texto: 'Olá, Diego. Envie o atestado médico do atleta afastado para liberarmos a substituição.', hora: '12/08/2026 10:05' }
    ]
  },
  {
    id: 'c2', protocolo: '2026-000104',
    assunto: 'Dúvida sobre formato de foto dos atletas',
    campeonato: 'cbs-2026', time: 't2', doCompetidor: true,
    status: 'encerrado', autor: 'Diego Martins',
    abertoEm: '2026-08-05', atualizadoEm: '2026-08-06',
    mensagens: [
      { de: 'usuario', autor: 'Diego Martins', texto: 'As fotos precisam ser em qual proporção?', hora: '05/08/2026 08:40' },
      { de: 'org', autor: 'Organização Phygital', texto: 'Proporção 3:4, mínimo 600x800px, JPG ou PNG até 5 MB.', hora: '06/08/2026 09:12' },
      { de: 'sistema', autor: null, texto: 'Chamado encerrado pela organização.', hora: '06/08/2026 09:15' }
    ]
  },
  {
    id: 'a2', protocolo: '2026-000118', assunto: 'Erro ao subir logo do time',
    campeonato: 'cbf-2026', time: null, doCompetidor: false,
    status: 'aberto', autor: 'Fúria Digital',
    abertoEm: '2026-08-13', atualizadoEm: null, mensagens: []
  },
  {
    id: 'a3', protocolo: '2026-000121', assunto: 'Solicitação de cancelamento de inscrição',
    campeonato: 'cbs-2026', time: null, doCompetidor: false,
    status: 'aberto', autor: 'Litoral Gaming',
    abertoEm: '2026-08-14', atualizadoEm: null, mensagens: []
  },
  {
    id: 'a4', protocolo: '2026-000105', assunto: 'Confirmação de vaga na lista oficial',
    campeonato: 'cbb-2026', time: null, doCompetidor: false,
    status: 'andamento', autor: 'Cangaço 3x3',
    abertoEm: '2026-08-12', atualizadoEm: null, mensagens: []
  }
];

/* --------------------------------------------------------------------------
   E-MAIL
   -------------------------------------------------------------------------- */

/* Configuração única de SMTP. A senha não tem coluna no esquema de propósito:
   é lida de PHYGITAL_SMTP_SENHA no momento do envio. */
const SMTP = {
  email: 'inscricoes@phygitalgamesbr.com.br',
  usuario: 'inscricoes@phygitalgamesbr.com.br',
  servidorEntrada: 'mail.phygitalgamesbr.com.br',
  imap: 993,
  pop3: 995,
  servidorSaida: 'mail.phygitalgamesbr.com.br',
  smtp: 465,
  seguranca: 'SSL',
  remetente: 'Phygital Brasil'
};

/* Todo alerta automático sai de um destes modelos. As variáveis entre chaves
   são trocadas pelo valor real no momento do envio. */
const MODELOS_EMAIL = [
  { id: 'conta-criada', grupo: 'Conta', nome: 'Conta criada',
    quando: 'Assim que o usuário conclui o cadastro no Painel do Competidor.',
    para: 'competidor', assunto: 'Bem-vindo à Phygital Brasil, {{usuario.nome}}',
    corpo: '<p>Olá, <b>{{usuario.nome}}</b>.</p><p>Sua conta foi criada com o e-mail {{usuario.email}}. A partir de agora você pode cadastrar times e inscrevê-los nos campeonatos da Phygital Brasil.</p><p>Bom jogo!</p>' },
  { id: 'codigo-verificacao', grupo: 'Conta', nome: 'Código de verificação',
    quando: 'Confirmação de e-mail, alteração de dados e troca de endereço.',
    para: 'competidor', assunto: 'Seu código de verificação é {{codigo}}',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Seu código de verificação é <b>{{codigo}}</b>. Ele vale por 15 minutos.</p><p>Se não foi você que pediu, ignore este e-mail.</p>' },
  { id: 'senha-recuperacao', grupo: 'Conta', nome: 'Recuperação de senha',
    quando: 'Quando o usuário pede uma nova senha na tela de login.',
    para: 'competidor', assunto: 'Recuperação de senha — Phygital Brasil',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Use o código <b>{{codigo}}</b> para criar uma nova senha. O código vale por 15 minutos.</p>' },
  { id: 'senha-alterada', grupo: 'Conta', nome: 'Senha alterada',
    quando: 'Confirmação enviada depois que a senha é trocada.',
    para: 'competidor', assunto: 'Sua senha foi alterada',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>A senha da sua conta foi alterada em {{data}}. Se não foi você, fale com a organização imediatamente.</p>' },

  { id: 'inscricao-confirmada', grupo: 'Inscrições', nome: 'Confirmação de inscrição',
    quando: 'Assim que o time é inscrito. Entra na Lista de Inscritos (triagem).',
    para: 'competidor', assunto: 'Inscrição recebida — protocolo {{inscricao.protocolo}}',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Recebemos a inscrição do time <b>{{time.nome}}</b> no campeonato <b>{{campeonato.nome}}</b>.</p><p>Protocolo: <b>{{inscricao.protocolo}}</b></p><p><b>Atenção:</b> esta mensagem confirma o recebimento da inscrição, mas <b>não garante vaga</b>. O time está na Lista de Inscritos e passará por triagem da organização.</p>' },
  { id: 'lista-oficial', grupo: 'Inscrições', nome: 'Movido para a Lista Oficial',
    quando: 'Quando o administrador move o time da triagem para a lista oficial.',
    para: 'competidor', assunto: 'Vaga confirmada em {{campeonato.nome}}',
    corpo: '<p>Boa notícia, {{usuario.nome}}!</p><p>O time <b>{{time.nome}}</b> foi confirmado na <b>Lista Oficial</b> de {{campeonato.nome}}.</p><p>Data: {{campeonato.data}} · Local: {{campeonato.local}}</p>' },
  { id: 'lista-espera', grupo: 'Inscrições', nome: 'Movido para a Lista de Espera',
    quando: 'Quando o administrador move o time para a lista de espera.',
    para: 'competidor', assunto: 'Seu time está na lista de espera',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>O time <b>{{time.nome}}</b> está na <b>Lista de Espera</b> de {{campeonato.nome}}. Avisaremos caso surja uma vaga.</p>' },
  { id: 'inscricoes-encerrando', grupo: 'Inscrições', nome: 'Encerramento das inscrições',
    quando: 'Aviso automático a poucos dias do prazo final.',
    para: 'competidor', assunto: 'As inscrições de {{campeonato.nome}} encerram em breve',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>As inscrições de <b>{{campeonato.nome}}</b> encerram em {{campeonato.encerramento}}. Depois dessa data qualquer alteração só será possível por chamado.</p>' },

  { id: 'chamado-aberto', grupo: 'Chamados', nome: 'Chamado aberto',
    quando: 'Confirmação para quem abriu o chamado.',
    para: 'competidor', assunto: 'Chamado {{chamado.protocolo}} registrado',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Seu chamado foi registrado sob o protocolo <b>{{chamado.protocolo}}</b> com o assunto "{{chamado.assunto}}".</p><p>Status atual: {{chamado.status}}</p>' },
  { id: 'chamado-respondido', grupo: 'Chamados', nome: 'Chamado respondido',
    quando: 'Quando a organização responde ou muda o status.',
    para: 'competidor', assunto: 'Atualização no chamado {{chamado.protocolo}}',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>Há uma atualização no chamado <b>{{chamado.protocolo}}</b>. Status: <b>{{chamado.status}}</b>.</p><p>Acesse o Painel do Competidor para ver a resposta completa.</p>' },
  { id: 'chamado-encerrado', grupo: 'Chamados', nome: 'Chamado encerrado',
    quando: 'Ao encerrar o atendimento.',
    para: 'competidor', assunto: 'Chamado {{chamado.protocolo}} encerrado',
    corpo: '<p>Olá, {{usuario.nome}}.</p><p>O chamado <b>{{chamado.protocolo}}</b> foi encerrado. Se precisar, abra um novo chamado pelo painel.</p>' },

  { id: 'adm-nova-inscricao', grupo: 'Alertas do administrador', nome: 'Nova inscrição recebida',
    quando: 'Cada vez que um time se inscreve em um campeonato.',
    para: 'admin', assunto: '[ADM] Nova inscrição em {{campeonato.nome}}',
    corpo: '<p>O time <b>{{time.nome}}</b> se inscreveu em <b>{{campeonato.nome}}</b>.</p><p>Protocolo {{inscricao.protocolo}} · responsável {{usuario.nome}} ({{usuario.email}}).</p><p>O time entrou na Lista de Inscritos e aguarda triagem.</p>' },
  { id: 'adm-novo-chamado', grupo: 'Alertas do administrador', nome: 'Novo chamado aberto',
    quando: 'Quando um responsável abre um chamado.',
    para: 'admin', assunto: '[ADM] Novo chamado {{chamado.protocolo}}',
    corpo: '<p>Novo chamado aberto por <b>{{usuario.nome}}</b> ({{time.nome}}).</p><p>Assunto: {{chamado.assunto}}</p><p>Campeonato: {{campeonato.nome}}</p>' },
  { id: 'adm-vagas-preenchidas', grupo: 'Alertas do administrador', nome: 'Vagas preenchidas',
    quando: 'Quando a lista oficial atinge o total de vagas do campeonato.',
    para: 'admin', assunto: '[ADM] {{campeonato.nome}} atingiu a lotação',
    corpo: '<p>A Lista Oficial de <b>{{campeonato.nome}}</b> atingiu <b>{{campeonato.vagas}}</b> vagas.</p><p>Novas inscrições continuam entrando na triagem e podem ser direcionadas à lista de espera.</p>' },
  { id: 'adm-inscricoes-encerradas', grupo: 'Alertas do administrador', nome: 'Inscrições encerradas',
    quando: 'Na data de encerramento das inscrições.',
    para: 'admin', assunto: '[ADM] Inscrições encerradas — {{campeonato.nome}}',
    corpo: '<p>As inscrições de <b>{{campeonato.nome}}</b> foram encerradas em {{campeonato.encerramento}}.</p><p>Total de inscritos: {{campeonato.inscritos}} · Lista oficial: {{campeonato.oficial}} · Lista de espera: {{campeonato.espera}}.</p><p>A partir de agora alterações dos times só por chamado.</p>' },
  { id: 'adm-falha-envio', grupo: 'Alertas do administrador', nome: 'Falha no envio de e-mail',
    quando: 'Quando o servidor SMTP recusa um envio.',
    para: 'admin', assunto: '[ADM] Falha no envio de e-mail',
    corpo: '<p>O servidor <b>{{smtp.servidor}}</b> recusou um envio em {{data}}.</p><p>Verifique as configurações em Disparo de E-mail → Configurações.</p>' }
];

/* Histórico de disparos já feitos. `data` mantém o formato da semente porque a
   tela de histórico imprime o valor cru. */
const EMAILS_ENVIADOS = [
  { id: 'em1', assunto: 'Confirmação de inscrição — Copa Phygital Futebol 2026', destino: 'Copa Phygital Futebol 2026', qtd: 18, data: '2026-08-03 09:14', status: 'entregue' },
  { id: 'em2', assunto: 'Encerramento das inscrições se aproxima', destino: 'Todos os campeonatos', qtd: 43, data: '2026-08-10 17:30', status: 'entregue' },
  { id: 'em3', assunto: 'Atualização do regulamento — Shooter Open', destino: 'Phygital Shooter Open', qtd: 14, data: '2026-08-12 11:02', status: 'entregue' }
];

/* ==========================================================================
   APOIO
   ========================================================================== */

/* Ordem de limpeza: filho antes do pai. Com PRAGMA foreign_keys = ON (ligado
   pelo esquema) apagar o pai primeiro violaria a chave estrangeira, e o pragma
   não pode ser desligado dentro de uma transação. */
const ORDEM_LIMPEZA = [
  'sessoes', 'codigos', 'tentativas_login',
  'documentos', 'jogadores', 'staff',
  'inscricoes',
  'chamado_mensagens', 'chamados',
  'auditoria',
  'emails_enviados', 'modelos_email',
  'times', 'campeonatos', 'contas',
  'ranking', 'ranking_config', 'resultados',
  'categorias', 'posts', 'eventos', 'parceiros',
  'banners', 'banners_site', 'smtp',
  /* Sem chave estrangeira (a coluna `tabela` aponta para sete tabelas), então
     o CASCADE não alcança: a limpeza tem que citar a tradução explicitamente. */
  'traducoes'
];

const contagens = new Map();

function contar(tabela, campo) {
  if (!contagens.has(tabela)) contagens.set(tabela, { inseridos: 0, existentes: 0 });
  contagens.get(tabela)[campo]++;
}

/**
 * INSERT idempotente: procura a linha pelas colunas de `chaves` e só insere se
 * não achar. É o que permite rodar a semente duas vezes sem duplicar.
 *
 * O nome da tabela e das colunas vem das constantes deste arquivo, nunca de
 * entrada externa; os valores sempre viajam como parâmetro.
 */
function inserir(tabela, dados, chaves = ['id']) {
  const linha = db.limpar(dados);
  const colunas = Object.keys(linha);

  if (chaves && chaves.length) {
    const onde = chaves.map((c) => `"${c}" = ?`).join(' AND ');
    if (db.um(`SELECT 1 FROM ${tabela} WHERE ${onde}`, ...chaves.map((c) => linha[c]))) {
      contar(tabela, 'existentes');
      return false;
    }
  }

  db.executar(
    `INSERT INTO ${tabela} (${colunas.map((c) => `"${c}"`).join(', ')})
     VALUES (${colunas.map(() => '?').join(', ')})`,
    ...colunas.map((c) => linha[c])
  );
  contar(tabela, 'inseridos');
  return true;
}

/**
 * Converte o rótulo 'DD/MM/AAAA HH:MM' das mensagens em data ordenável.
 * Fica sem fuso de propósito: o rótulo da semente é hora local, e cravar 'Z'
 * afirmaria um fuso que o dado não tem.
 */
function instanteDeRotulo(rotulo, alternativa) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(rotulo || ''));
  if (!m) return alternativa;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`;
}

const avisos = [];
const aviso = (texto) => avisos.push(texto);

/* --------------------------------------------------------------------------
   SENHAS
   -------------------------------------------------------------------------- */

/**
 * Senha aleatória forte. Repete até passar pela própria política do sistema
 * (auth.avaliarSenha), para que a senha impressa seja uma que o login aceite
 * de volta se o operador precisar digitá-la.
 */
function senhaAleatoria(contexto) {
  for (let tentativa = 0; tentativa < 50; tentativa++) {
    const candidata = crypto.randomBytes(18).toString('base64url');
    if (auth.avaliarSenha(candidata, contexto).length === 0) return candidata;
  }
  throw new Error('Não foi possível sortear uma senha dentro da política de senhas.');
}

/**
 * Lê a senha de uma variável de ambiente. Recusa senha fraca ANTES de abrir a
 * transação: é melhor a semeadura falhar do que a conta master nascer com uma
 * senha que o próprio sistema reprovaria.
 */
function senhaDoAmbiente(variavel, contexto) {
  if (!variavel) return null;
  const valor = process.env[variavel];
  if (!valor) return null;

  const problemas = auth.avaliarSenha(valor, contexto);
  if (problemas.length) {
    throw new Error(
      `A senha informada em ${variavel} não atende à política do sistema:\n` +
      problemas.map((p) => `    · ${p}`).join('\n')
    );
  }
  return valor;
}

/* Senhas sorteadas nesta execução, impressas uma única vez no fim. */
const senhasGeradas = [];

function criarConta({ id, nome, email, telefone, papel, nivel, criadoEm, variavelSenha, emailVerificado }) {
  const jaExiste = db.um(
    'SELECT id FROM contas WHERE id = ? OR lower(email) = ?', id, email.toLowerCase()
  );
  if (jaExiste) {
    contar('contas', 'existentes');
    return jaExiste.id;
  }

  const contexto = { email, nome };
  const doAmbiente = senhaDoAmbiente(variavelSenha, contexto);
  const senha = doAmbiente || senhaAleatoria(contexto);

  inserir('contas', {
    id, nome, email, telefone,
    ...auth.criarSenha(senha),
    papel,
    nivel: nivel || null,
    email_verificado: db.paraBool(emailVerificado),
    /* Senha sorteada é provisória: o briefing manda trocar no primeiro acesso. */
    senha_provisoria: db.paraBool(!doAmbiente),
    criado_em: criadoEm,
    atualizado_em: null,
    ultimo_acesso_em: null,
    arquivado_em: null
  });

  if (!doAmbiente) senhasGeradas.push({ nome, email, papel, nivel, senha });
  return id;
}

/* ==========================================================================
   SEMEADURA
   ========================================================================== */

function esvaziar() {
  let removidas = 0;
  for (const tabela of ORDEM_LIMPEZA) {
    removidas += db.executar(`DELETE FROM ${tabela}`).changes;
  }

  /* Zera os contadores de AUTOINCREMENT: sem isso um banco recriado continua
     numerando de onde o anterior parou. */
  const temSequencia = db.valor(
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
  );
  if (temSequencia) db.executar('DELETE FROM sqlite_sequence');

  return removidas;
}

function semearContas() {
  criarConta({
    id: COMPETIDOR.id, nome: COMPETIDOR.nome, email: COMPETIDOR.email,
    telefone: COMPETIDOR.telefone, papel: 'competidor', nivel: null,
    criadoEm: COMPETIDOR.criadoEm, variavelSenha: COMPETIDOR.variavelSenha,
    emailVerificado: true
  });

  for (const a of ADMINISTRADORES) {
    criarConta({
      id: a.id, nome: a.nome, email: a.email, telefone: a.telefone,
      papel: 'admin', nivel: a.nivel, criadoEm: a.criadoEm,
      variavelSenha: a.variavelSenha, emailVerificado: a.emailVerificado
    });
  }
}

function semearCampeonatos() {
  for (const c of CAMPEONATOS) {
    const m = regras.modalidade(c.modalidade);

    inserir('campeonatos', {
      id: c.id,
      nome: c.nome,
      modalidade: c.modalidade,
      banner: c.banner,
      vagas: c.vagas,
      /* Limites ausentes na semente vêm da modalidade — é o que o esquema
         chama de "copiados no momento da criação". */
      jogadores_min: c.jogadoresMin != null ? c.jogadoresMin : m.jogadoresMin,
      jogadores_max: c.jogadoresMax != null ? c.jogadoresMax : m.jogadoresMax,
      /* No protótipo `reservas` era um sim/não; a coluna é numérica, então
         guardamos o teto da modalidade (0 quando o campeonato não aceita
         reserva). Vale como limite e continua verdadeiro como sinalizador. */
      reservas: c.reservas === false ? 0 : m.reservasMax,
      staff_max: c.staffMax != null ? c.staffMax : m.staffMax,
      data: c.data,
      data_fim: c.dataFim,
      local: c.local,
      abertura_inscricoes: c.aberturaInscricoes,
      encerramento_inscricoes: c.encerramentoInscricoes,
      descricao: c.descricao,
      premiacao: db.paraJson(c.premiacao || null),
      termos: c.termos || null,
      regulamento: c.regulamento || null,
      status: c.status,
      classificacao: db.paraJson(c.classificacao || null),
      /* A semente não registrava criação de campeonato: a abertura das
         inscrições é a data mais antiga que comprovadamente já existia. */
      criado_em: c.aberturaInscricoes || c.data,
      atualizado_em: null,
      arquivado_em: null
    });
  }
}

function semearTimes(contaId) {
  for (const t of TIMES) {
    inserir('times', {
      id: t.id,
      conta_id: contaId,
      nome: t.nome,
      modalidade: t.modalidade,
      categoria: t.categoria || null,
      escudo: t.escudo,
      descricao: t.descricao,
      historico: t.historico,
      criado_em: t.criadoEm,
      atualizado_em: null,
      arquivado_em: null
    });

    /* `ordem` guarda a sequência do array: é ela que o front-end lista e que o
       export usa para nomear as fotos. */
    t.jogadores.forEach((j, i) => {
      const jogadorId = `${t.id}-j${i + 1}`;

      inserir('jogadores', {
        id: jogadorId,
        time_id: t.id,
        ordem: i + 1,
        nome: j.nome,
        apelido: j.apelido || null,
        numero: j.numero != null ? j.numero : null,
        funcao: j.funcao || null,
        email: j.email || null,
        tel: j.tel || null,
        nasc: j.nasc || null,
        insta: j.insta || null,
        foto: j.foto || null,
        steam: j.steam || null,
        faceit: j.faceit || null,
        reserva: db.paraBool(j.reserva)
      });

      for (const doc of (j.documentos || [])) {
        inserir('documentos', {
          /* Um documento por tipo e por jogador (o esquema tem índice único
             nessa dupla), então o id pode ser derivado dela. */
          id: `${jogadorId}-${doc.tipo}`,
          jogador_id: jogadorId,
          tipo: doc.tipo,
          arquivo: doc.arquivo || null,
          validade: doc.validade || null,
          status: doc.status || 'enviado',
          observacao: doc.observacao || null,
          /* A semente não traz data de envio nem de conferência. */
          enviado_em: null,
          conferido_em: null,
          conferido_por: null
        });
      }
    });

    t.staff.forEach((s, i) => {
      inserir('staff', {
        id: `${t.id}-s${i + 1}`,
        time_id: t.id,
        ordem: i + 1,
        nome: s.nome,
        papel: s.papel || null,
        email: s.email || null,
        tel: s.tel || null,
        nasc: s.nasc || null,
        insta: s.insta || null,
        foto: s.foto || null
      });
    });
  }
}

/* Confere o elenco semeado contra as regras da modalidade. Não interrompe: um
   banco de demonstração fora da regra é problema a corrigir, não motivo para
   impedir o desenvolvedor de subir o ambiente. */
function conferirElencos() {
  for (const t of TIMES) {
    const veredito = regras.validarElencoDoTime(t.id);
    if (!veredito.valido) {
      aviso(`Elenco de "${t.nome}" fora das regras de ${t.modalidade}: ${veredito.erros.join(' ')}`);
    }

    for (const j of t.jogadores) {
      const j2 = regras.validarJogador(t.modalidade, j);
      if (!j2.valido) aviso(`Jogador "${j.nome}" (${t.nome}): ${j2.erros.join(' ')}`);
    }
  }
}

function semearInscricoes() {
  for (const i of INSCRICOES) {
    inserir('inscricoes', {
      id: i.id,
      campeonato_id: i.campeonato,
      time_id: i.time,
      protocolo: i.protocolo,
      status: i.status,
      data: i.data,
      observacao: null,
      criado_em: i.data,
      atualizado_em: null
    });
  }
}

function semearChamados(contaId) {
  for (const c of CHAMADOS) {
    inserir('chamados', {
      id: c.id,
      protocolo: c.protocolo,
      conta_id: c.doCompetidor ? contaId : null,
      campeonato_id: c.campeonato,
      time_id: c.time,
      assunto: c.assunto,
      status: c.status,
      autor: c.autor,
      aberto_em: c.abertoEm,
      atualizado_em: c.atualizadoEm,
      arquivado_em: null
    });

    if (!c.mensagens.length) continue;

    /* chamado_mensagens não tem chave de negócio (o id é sequencial), então a
       idempotência olha a conversa inteira: chamado que já tem mensagem não
       recebe a semente de novo. */
    const jaTemConversa = db.valor(
      'SELECT COUNT(*) FROM chamado_mensagens WHERE chamado_id = ?', c.id
    );
    if (jaTemConversa) {
      c.mensagens.forEach(() => contar('chamado_mensagens', 'existentes'));
      continue;
    }

    for (const m of c.mensagens) {
      inserir('chamado_mensagens', {
        chamado_id: c.id,
        de: m.de,
        autor: m.autor || null,
        hora: m.hora,
        texto: m.texto,
        criado_em: instanteDeRotulo(m.hora, c.abertoEm)
      }, null);
    }
  }
}

function semearRanking() {
  for (const [modalidade, lista] of Object.entries(RANKING)) {
    lista.forEach((r, i) => {
      inserir('ranking', {
        modalidade,
        nome: r.nome,
        uf: r.uf,
        v: r.v,
        e: r.e,
        d: r.d,
        camp: r.camp,
        titulos: r.titulos,
        gotf: db.paraBool(r.gotf),
        posicao: i + 1
      }, ['modalidade', 'nome']);
    });
  }

  for (const [modalidade, c] of Object.entries(RANKING_CONFIG)) {
    inserir('ranking_config', {
      modalidade,
      pontos_vitoria: c.pontosVitoria,
      pontos_empate: c.pontosEmpate,
      pontos_derrota: c.pontosDerrota,
      bonus_titulo: c.bonusTitulo,
      bonus_gotf: c.bonusGotf,
      min_campeonatos: c.minCampeonatos,
      ativo: db.paraBool(c.ativo)
    }, ['modalidade']);
  }
}

function semearResultados() {
  for (const r of RESULTADOS) {
    inserir('resultados', {
      data: r.data,
      mod: r.mod,
      camp: r.camp,
      local: r.local,
      fase: r.fase,
      casa_nome: r.casa.nome,
      casa_escudo: r.casa.escudo,
      casa_digital: r.casa.digital,
      casa_fisico: r.casa.fisico,
      fora_nome: r.fora.nome,
      fora_escudo: r.fora.escudo,
      fora_digital: r.fora.digital,
      fora_fisico: r.fora.fisico
      /* Sem id de negócio: o confronto se identifica por data, modalidade e os
         dois times. */
    }, ['data', 'mod', 'casa_nome', 'fora_nome']);
  }
}

function semearConteudo() {
  for (const c of CATEGORIAS) {
    inserir('categorias', { id: c.id, nome: c.nome, descricao: c.descricao, cor: c.cor, arquivado_em: null });
  }

  for (const p of POSTS) {
    inserir('posts', {
      id: p.id,
      titulo: p.titulo,
      cat: p.cat,
      data: p.data,
      autor: p.autor,
      img: p.img,
      resumo: p.resumo,
      /* A semente do protótipo só tinha resumo; o corpo é escrito no CMS. */
      corpo: null,
      publicado: 1,
      criado_em: p.data,
      atualizado_em: null,
      arquivado_em: null
    });
  }

  for (const e of EVENTOS) {
    inserir('eventos', { id: e.id, titulo: e.titulo, mod: e.mod, ano: e.ano, local: e.local, fotos: e.fotos, arquivado_em: null });
  }

  PARCEIROS.forEach((p, i) => {
    inserir('parceiros', {
      id: `pa${i + 1}`,
      nome: p.nome,
      tipo: p.tipo,
      /* O front-end monta o logo a partir da ordem; nada a guardar aqui. */
      logo: null,
      ordem: i + 1,
      arquivado_em: null
    });
  });

  for (const b of BANNERS) {
    inserir('banners', {
      id: b.id, titulo: b.titulo, img: b.img, link: b.link,
      ordem: b.ordem, ativo: db.paraBool(b.ativo), arquivado_em: null
    });
  }

  for (const s of BANNERS_SITE) {
    inserir('banners_site', {
      id: s.id,
      titulo: s.titulo,
      texto: s.texto,
      eyebrow: s.eyebrow,
      botao: s.botao, link: s.link,
      botao2: s.botao2, link2: s.link2,
      midia: s.midia,
      img: s.img,
      video: s.video,
      titulo_tamanho: s.tituloTamanho,
      sem_texto: db.paraBool(s.semTexto),
      ordem: s.ordem,
      ativo: db.paraBool(s.ativo),
      arquivado_em: null
    });
  }
}

/* --------------------------------------------------------------------------
   TRADUÇÃO DE EXEMPLO

   O suficiente para conferir o caminho inteiro de ponta a ponta: um campeonato
   e um post completos em inglês e espanhol, uma categoria, um banner do hero e
   um modelo de e-mail.

   As lacunas são de propósito. 'cbb-2026' tem só o nome em inglês e nada em
   espanhol, e o post p1 não tem `corpo` traduzido: é assim que dá para ver na
   tela que o campo sem tradução volta em português em vez de sair vazio.
   -------------------------------------------------------------------------- */

const TRADUCOES = [
  {
    tabela: 'campeonatos', registro: 'cbf-2026',
    en: {
      nome: 'Phygital Football Cup 2026 — National Stage',
      descricao: 'The main stage of the national calendar. 24 teams compete for a direct spot in the Games of the Future qualifier.',
      local: 'Phygital Arena — São Paulo, Brazil',
      termos: 'By registering the team, the person in charge declares that every athlete has granted image rights and is physically fit to compete.'
    },
    es: {
      nome: 'Copa Phygital de Fútbol 2026 — Etapa Nacional',
      descricao: 'La principal etapa del calendario nacional. 24 equipos disputan una plaza directa en la clasificatoria de los Games of the Future.',
      local: 'Arena Phygital — São Paulo, Brasil',
      termos: 'Al inscribir al equipo, el responsable declara que todos los atletas cuentan con autorización de imagen y están aptos físicamente para competir.'
    }
  },
  {
    /* Tradução incompleta de propósito: prova o fallback campo a campo. */
    tabela: 'campeonatos', registro: 'cbb-2026',
    en: { nome: 'Phygital 3x3 Basketball Circuit — 2nd Edition' }
  },
  {
    tabela: 'posts', registro: 'p1',
    en: {
      titulo: 'Phygital Football Cup 2026 opens registration for 24 teams',
      resumo: 'The national stage takes place in September, in São Paulo, with a direct spot in the Games of the Future qualifier for the champion.'
    },
    es: {
      titulo: 'La Copa Phygital de Fútbol 2026 abre inscripciones para 24 equipos',
      resumo: 'La etapa nacional se celebra en septiembre, en São Paulo, con plaza directa en la clasificatoria de los Games of the Future para el campeón.'
    }
  },
  {
    tabela: 'categorias', registro: 'campeonatos',
    en: { nome: 'Championships' },
    es: { nome: 'Campeonatos' }
  },
  {
    tabela: 'modelos_email', registro: 'codigo-verificacao',
    en: {
      assunto: 'Your verification code is {{codigo}}',
      corpo: '<p>Hello, {{usuario.nome}}.</p><p>Your verification code is <b>{{codigo}}</b>. It is valid for 15 minutes.</p><p>If you did not request it, ignore this e-mail.</p>'
    },
    es: {
      assunto: 'Tu código de verificación es {{codigo}}',
      corpo: '<p>Hola, {{usuario.nome}}.</p><p>Tu código de verificación es <b>{{codigo}}</b>. Es válido por 15 minutos.</p><p>Si no lo has solicitado, ignora este correo.</p>'
    }
  }
];

function semearTraducoes() {
  const agora = db.agora();

  for (const item of TRADUCOES) {
    /* O registro pode não existir num banco parcialmente semeado; sem esta
       guarda, a tradução ficaria órfã e nunca seria lida por ninguém. */
    if (!db.um(`SELECT id FROM ${item.tabela} WHERE id = ?`, item.registro)) continue;

    for (const idioma of ['en', 'es']) {
      const campos = item[idioma];
      if (!campos) continue;

      for (const [campo, texto] of Object.entries(campos)) {
        inserir('traducoes', {
          tabela: item.tabela,
          registro_id: item.registro,
          campo,
          idioma,
          texto,
          atualizado_em: agora
        }, ['tabela', 'registro_id', 'campo', 'idioma']);
      }
    }
  }
}

function semearEmail() {
  inserir('smtp', {
    id: 1,
    email: SMTP.email,
    usuario: SMTP.usuario,
    servidor_entrada: SMTP.servidorEntrada,
    imap: SMTP.imap,
    pop3: SMTP.pop3,
    servidor_saida: SMTP.servidorSaida,
    smtp: SMTP.smtp,
    seguranca: SMTP.seguranca,
    remetente: SMTP.remetente,
    atualizado_em: db.agora()
  });

  for (const m of MODELOS_EMAIL) {
    inserir('modelos_email', {
      id: m.id, grupo: m.grupo, nome: m.nome, quando: m.quando,
      para: m.para, assunto: m.assunto, corpo: m.corpo,
      ativo: 1, atualizado_em: null
    });
  }

  for (const e of EMAILS_ENVIADOS) {
    inserir('emails_enviados', {
      id: e.id,
      modelo_id: null,
      assunto: e.assunto,
      destino: e.destino,
      para: null,
      corpo: null,
      qtd: e.qtd,
      status: e.status,
      data: e.data
    });
  }
}

/**
 * Popula o banco. Com `recriar`, apaga o conteúdo de todas as tabelas antes —
 * o arquivo do banco continua o mesmo.
 * Tudo em uma transação: se qualquer passo falhar, nada é gravado.
 */
function semear({ recriar = false } = {}) {
  contagens.clear();
  senhasGeradas.length = 0;
  avisos.length = 0;

  /* Valida as senhas do ambiente antes de abrir a transação, para o erro
     aparecer sem nem ter começado a mexer no banco. */
  senhaDoAmbiente('PHYGITAL_ADMIN_SENHA', { email: EMAIL_ADMIN, nome: 'Inscrições Phygital' });
  senhaDoAmbiente('PHYGITAL_COMPETIDOR_SENHA', { email: EMAIL_COMPETIDOR, nome: COMPETIDOR.nome });

  const removidas = db.transacao(() => {
    const apagadas = recriar ? esvaziar() : 0;

    semearContas();

    /* A conta pode já existir de uma execução anterior: os times se ligam à
       que está no banco, não à que acabamos de tentar criar. */
    const conta = db.um('SELECT id FROM contas WHERE lower(email) = ?', EMAIL_COMPETIDOR.toLowerCase());
    if (!conta) throw new Error('Conta do competidor não encontrada depois da criação.');

    semearCampeonatos();
    semearTimes(conta.id);
    semearInscricoes();
    semearChamados(conta.id);
    semearRanking();
    semearResultados();
    semearConteudo();
    semearEmail();
    /* Depois de conteúdo e e-mail: a tradução aponta para registros que os dois
       acabaram de criar e é ignorada quando o registro não existe. */
    semearTraducoes();

    conferirElencos();

    const inseridas = total();
    /* Só registra auditoria quando algo foi realmente escrito — auditar uma
       execução que não mudou nada encheria a trilha e quebraria a
       idempotência. */
    if (inseridas > 0 || apagadas > 0) {
      regras.registrar(null, 'sistema', 'semente',
        recriar ? 'recriou o banco' : 'semeou o banco',
        `${inseridas} linha(s) inserida(s)` + (apagadas ? ` · ${apagadas} removida(s)` : ''));
    }

    return apagadas;
  });

  imprimirResumo({ recriar, removidas });

  return {
    recriado: recriar,
    removidas,
    inseridas: total(),
    contagens: Object.fromEntries(contagens),
    /* Senha nunca sai daqui em texto: quem gerou já imprimiu uma única vez. */
    senhasGeradas: senhasGeradas.map((s) => ({ email: s.email, papel: s.papel, nivel: s.nivel }))
  };
}

function total() {
  let soma = 0;
  for (const c of contagens.values()) soma += c.inseridos;
  return soma;
}

/* --------------------------------------------------------------------------
   SAÍDA NO TERMINAL
   -------------------------------------------------------------------------- */

const LINHA = '='.repeat(72);

function imprimirResumo({ recriar, removidas }) {
  console.log('');
  console.log(LINHA);
  console.log('SEMENTE PHYGITAL BRASIL');
  console.log(`Banco: ${db.ARQUIVO}`);
  if (recriar) console.log(`Modo --recriar: ${removidas} linha(s) apagada(s) antes de popular.`);
  console.log(LINHA);

  const largura = Math.max(...[...contagens.keys()].map((t) => t.length), 12);
  for (const [tabela, c] of contagens) {
    const existentes = c.existentes ? `   (${c.existentes} já existia(m))` : '';
    console.log(`  ${tabela.padEnd(largura)}  ${String(c.inseridos).padStart(4)} inserida(s)${existentes}`);
  }

  console.log(`  ${'-'.repeat(largura + 22)}`);
  console.log(`  ${'TOTAL'.padEnd(largura)}  ${String(total()).padStart(4)} linha(s)`);

  if (!total()) {
    console.log('');
    console.log('  Nada a fazer: o banco já estava semeado.');
    console.log('  Use --recriar para limpar e popular de novo.');
  }

  if (!process.env.PHYGITAL_SMTP_SENHA) {
    console.log('');
    console.log('  Nota: PHYGITAL_SMTP_SENHA não está definida. A senha do SMTP não é');
    console.log('  guardada no banco; sem a variável, o envio real de e-mail não sobe.');
  }

  for (const a of avisos) {
    console.log('');
    console.log(`  AVISO: ${a}`);
  }

  imprimirSenhas();
  console.log('');
}

function imprimirSenhas() {
  if (!senhasGeradas.length) return;

  console.log('');
  console.log(LINHA);
  console.log('!!  SENHAS GERADAS — ESTA É A ÚNICA VEZ QUE ELAS APARECEM  !!');
  console.log('');
  console.log('    Guarde agora em um gerenciador de senhas. Elas não ficam em');
  console.log('    lugar nenhum: o banco guarda apenas o hash scrypt.');
  console.log('    Todas estão marcadas como provisórias — o sistema vai exigir a');
  console.log('    troca no primeiro acesso.');
  console.log(LINHA);

  for (const s of senhasGeradas) {
    const papel = s.nivel ? `${s.papel}/${s.nivel}` : s.papel;
    console.log('');
    console.log(`  ${s.nome}  (${papel})`);
    console.log(`  e-mail: ${s.email}`);
    console.log(`  senha : ${s.senha}`);
  }

  console.log('');
  console.log(LINHA);
  console.log('  Para definir as senhas você mesmo, exporte antes de semear:');
  console.log('    PHYGITAL_ADMIN_SENHA e PHYGITAL_COMPETIDOR_SENHA');
  console.log(LINHA);
}

/* --------------------------------------------------------------------------
   LINHA DE COMANDO
   -------------------------------------------------------------------------- */

if (require.main === module) {
  const argumentos = process.argv.slice(2);
  const desconhecidos = argumentos.filter((a) => a !== '--recriar');

  if (desconhecidos.length) {
    console.error(`Argumento não reconhecido: ${desconhecidos.join(', ')}`);
    console.error('Uso: node server/semente.js [--recriar]');
    process.exit(1);
  }

  let codigo = 0;
  try {
    semear({ recriar: argumentos.includes('--recriar') });
  } catch (erro) {
    console.error('');
    console.error('A semeadura falhou e nada foi gravado:');
    console.error(`  ${erro.message}`);
    console.error('');
    codigo = 1;
  }

  db.fechar();
  process.exit(codigo);
}

module.exports = { semear };
