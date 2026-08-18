/* ==========================================================================
   PHYGITAL BRASIL — CAMADA DE DADOS

   Um arquivo, dois modos, decididos sozinho no carregamento:

     modo 'api'    há um back-end em /api. Uma chamada a /api/bootstrap enche o
                   cache em memória e as leituras passam a servir dados reais.
                   As escritas vão para a API.
     modo 'local'  não há back-end (GitHub Pages, file://, python -m http.server).
                   Vale a semente de demonstração + localStorage, exatamente
                   como antes desta migração. Nada muda nesse caminho.

   O contrato de PB.dados.* é o mesmo nos dois modos: mesma assinatura, mesmo
   tipo de retorno, leitura SÍNCRONA. É o que permite que as ~50 páginas do
   site continuem intocadas.

   --------------------------------------------------------------------------
   POR QUE XMLHttpRequest SÍNCRONO

   Escolha consciente, não descuido. O script de cada página roda inline
   durante o parse do HTML e chama PB.dados.campeonatos(), PB.dados.time(id) e
   afins na mesma linha em que monta a tela. Tornar a leitura assíncrona
   exigiria reescrever as ~50 páginas — que é justamente o que esta migração
   não pode fazer.

   O custo é conhecido: o XHR síncrono trava a thread principal enquanto o
   servidor responde e os navegadores avisam no console que ele está
   depreciado. Como as duas chamadas são locais, no mesmo host que serviu a
   página, e acontecem uma única vez por carga, o bloqueio é de poucos
   milissegundos.

   A rota de saída está pronta abaixo: PB.api.* é o mesmo back-end em fetch,
   devolvendo Promises. Toda página nova deve usar PB.api.*; conforme as
   páginas antigas forem migrando para ele, este arquivo perde o XHR síncrono
   sem que o resto do front-end perceba.
   ========================================================================== */
(function (global) {
  'use strict';

  var CHAVE = 'phygital.dados.v2';
  var CHAVE_SESSAO = 'phygital.sessao.v1';

  /* A API mora na raiz do mesmo host que serviu a página, então o caminho é
     absoluto: vale igual para /index.html, /painel/*.html e /admin/*.html. */
  var BASE = '/api';

  var _modo = 'local';
  var _cache = null;
  var _conta = null;      /* conta da sessão, como o servidor a enxerga */
  var _idiomaResolvido = null; /* idioma em que o servidor traduziu o cache */
  var _espelho = null;    /* foto do cache logo após a última sincronização */
  var _arquivados = null; /* memória curta do histórico (modo api) */

  /* ---------------------------------------------------------------------
     CONTAS DE ACESSO (só modo local)

     No modo api este array fica VAZIO: quem valida credencial é o servidor e
     nenhum e-mail ou senha precisa existir dentro deste arquivo.

     No modo local (site publicado no GitHub Pages, sem back-end) o array traz
     as contas de teste, para dar como fazer login sem servidor.
     --------------------------------------------------------------------- */
  var CONTAS = [
    {
      email: 'inscricoes@phygitalgamesbr.com.br',
      senha: 'Phygital@2026',
      papel: 'admin',
      nivel: 'master',
      nome: 'Inscrições Phygital',
      destino: '../admin/index.html'
    },
    {
      email: 'phygitalbrasilgames@gmail.com',
      senha: 'Phygital@2026',
      papel: 'competidor',
      nome: 'Phygital Brasil Games',
      destino: 'inicio.html'
    }
  ];

  /* ---------------------------------------------------------------------
     REGRAS POR MODALIDADE — vindas do briefing (páginas 3 a 6)
     Fonte única de verdade para validação de elenco em todo o sistema.
     No modo api esta cópia é substituída pela que /api/bootstrap devolve, para
     cliente e servidor não validarem com regras divergentes.
     --------------------------------------------------------------------- */
  var MODALIDADES = {
    futebol: {
      id: 'futebol',
      nome: 'Phygital Futebol',
      curto: 'Futebol',
      cor: '#009B4A',
      jogadoresMin: 6,
      jogadoresMax: 8,
      reservasMax: 3,
      staffMax: 3,
      staffRotulo: 'Treinador + 2 da comissão técnica ou mídia',
      temCategoria: true,
      temNumeroCamisa: true,
      temFuncao: true,
      temSteam: false,
      categorias: ['Sub 16', 'Sub 17', 'Sub 18', 'Amador', 'Profissional'],
      descricao: 'Partidas que começam no digital e terminam no gramado. Duas metades, um só placar.'
    },
    basquete: {
      id: 'basquete',
      nome: 'Phygital Basquete',
      curto: 'Basquete',
      cor: '#DF9911',
      jogadoresMin: 3,
      jogadoresMax: 4,
      reservasMax: 2,
      staffMax: 2,
      staffRotulo: 'Treinador + 1 da comissão técnica',
      temCategoria: false,
      temNumeroCamisa: true,
      temFuncao: false,
      temSteam: false,
      categorias: [],
      descricao: '3x3 na quadra e no console. Ritmo curto, decisão rápida, virada até o último lance.'
    },
    shooter: {
      id: 'shooter',
      nome: 'Phygital Shooter',
      curto: 'Shooter',
      cor: '#0A66B1',
      jogadoresMin: 5,
      jogadoresMax: 5,
      reservasMax: 3,
      staffMax: 1,
      staffRotulo: 'Treinador',
      temCategoria: false,
      temNumeroCamisa: false,
      temFuncao: false,
      temSteam: true,
      categorias: [],
      descricao: 'Cinco no servidor, cinco na arena. Precisão digital validada no confronto físico.'
    },
    dance: {
      id: 'dance',
      nome: 'Phygital Dance',
      curto: 'Dance',
      cor: '#FCE001',
      jogadoresMin: 1,
      jogadoresMax: 1,
      reservasMax: 0,
      staffMax: 1,
      staffRotulo: 'Staff (opcional)',
      temCategoria: false,
      temNumeroCamisa: true,
      temFuncao: false,
      temSteam: false,
      individual: true,
      staffOpcional: true,
      categorias: [],
      descricao: 'Atleta solo. Coreografia julgada por precisão de movimento e execução em pista.'
    },
    outros: {
      id: 'outros',
      nome: 'Outras Modalidades',
      curto: 'Outros',
      cor: '#6E7377',
      jogadoresMin: 1,
      jogadoresMax: 12,
      reservasMax: 3,
      staffMax: 3,
      staffRotulo: 'Comissão',
      temCategoria: false,
      temNumeroCamisa: false,
      temFuncao: false,
      temSteam: false,
      categorias: [],
      descricao: 'Novas disputas que a Phygital Brasil leva à arena. Formato definido por edital.'
    }
  };

  /* ---------------------------------------------------------------------
     STATUS
     --------------------------------------------------------------------- */
  var STATUS_INSCRICAO = {
    triagem:  { id: 'triagem',  rotulo: 'Em triagem',    classe: 'tag--amarela' },
    oficial:  { id: 'oficial',  rotulo: 'Lista oficial', classe: 'tag--verde' },
    espera:   { id: 'espera',   rotulo: 'Lista de espera', classe: 'tag--azul' },
    cancelada:{ id: 'cancelada',rotulo: 'Cancelada',     classe: 'tag--erro' }
  };

  var STATUS_CHAMADO = {
    aberto:     { id: 'aberto',     rotulo: 'Aberto',        classe: 'tag--amarela' },
    andamento:  { id: 'andamento',  rotulo: 'Em andamento',  classe: 'tag--azul' },
    respondido: { id: 'respondido', rotulo: 'Respondido',    classe: 'tag--verde' },
    encerrado:  { id: 'encerrado',  rotulo: 'Encerrado',     classe: 'tag--cinza' }
  };

  /* ---------------------------------------------------------------------
     DOCUMENTOS DO ATLETA
     O briefing cita "documento vencido" como causa comum de pendência, mas
     não previa onde anexá-lo. Cada jogador passa a ter documentos com
     validade e status de conferência pela organização.
     --------------------------------------------------------------------- */
  var TIPOS_DOCUMENTO = {
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

  var STATUS_DOCUMENTO = {
    pendente:  { id: 'pendente',  rotulo: 'Não enviado', classe: 'tag--cinza' },
    enviado:   { id: 'enviado',   rotulo: 'Em conferência', classe: 'tag--amarela' },
    aprovado:  { id: 'aprovado',  rotulo: 'Aprovado',    classe: 'tag--verde' },
    recusado:  { id: 'recusado',  rotulo: 'Recusado',    classe: 'tag--erro' },
    vencido:   { id: 'vencido',   rotulo: 'Vencido',     classe: 'tag--erro' }
  };

  var STATUS_CAMPEONATO = {
    rascunho:   { id: 'rascunho',   rotulo: 'Rascunho',            classe: 'tag--cinza' },
    inscricoes: { id: 'inscricoes', rotulo: 'Inscrições abertas',  classe: 'tag--verde' },
    fechado:    { id: 'fechado',    rotulo: 'Inscrições encerradas', classe: 'tag--amarela' },
    andamento:  { id: 'andamento',  rotulo: 'Em andamento',        classe: 'tag--azul' },
    encerrado:  { id: 'encerrado',  rotulo: 'Encerrado',           classe: 'tag--cinza' }
  };

  /* ---------------------------------------------------------------------
     SEMENTE DE DEMONSTRAÇÃO (modo local)
     --------------------------------------------------------------------- */
  function semente() {
    return {
      campeonatos: [
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
          ]},
          termos: 'Ao inscrever o time o responsável declara que todos os atletas possuem autorização de imagem e estão aptos fisicamente à disputa.',
          regulamento: 'regulamento-copa-futebol-2026.pdf',
          status: 'inscricoes',
          inscritos: 18, oficial: 12, espera: 4
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
          status: 'inscricoes',
          inscritos: 11, oficial: 8, espera: 2
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
          ]},
          termos: 'Obrigatório informar Steam64 e perfil Faceit válidos. Contas com banimento ativo serão desclassificadas.',
          regulamento: 'regulamento-shooter-open.pdf',
          status: 'inscricoes',
          inscritos: 14, oficial: 10, espera: 3
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
          ]},
          termos: 'Atleta individual. Staff opcional.',
          regulamento: 'regulamento-dance-2025.pdf',
          status: 'encerrado',
          inscritos: 38, oficial: 36, espera: 0,
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
          inscritos: 20, oficial: 20, espera: 0,
          classificacao: [
            { pos: 1, nome: 'Tigres Phygital', uf: 'SP' },
            { pos: 2, nome: 'Fúria Digital', uf: 'RJ' },
            { pos: 3, nome: 'Leões do Cerrado', uf: 'DF' }
          ]
        }
      ],

      /* Últimos confrontos apurados — o placar phygital é a soma das duas metades:
         resultado na disputa digital + resultado na disputa física. */
      resultados: [
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
      ],

      /* Ranking global por modalidade — alimentado pela apuração dos campeonatos */
      ranking: {
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
      },

      posts: [
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
      ],

      eventos: [
        { id: 'e1', titulo: 'Copa Phygital Futebol 2025 — Final', mod: 'futebol', ano: 2025, local: 'São Paulo, SP', fotos: 42 },
        { id: 'e2', titulo: 'Dance Championship 2025', mod: 'dance', ano: 2025, local: 'Recife, PE', fotos: 38 },
        { id: 'e3', titulo: 'Shooter Open 2025 — Etapa Sul', mod: 'shooter', ano: 2025, local: 'Porto Alegre, RS', fotos: 27 },
        { id: 'e4', titulo: 'Circuito Basquete 3x3 — 1ª Edição', mod: 'basquete', ano: 2025, local: 'Belo Horizonte, MG', fotos: 31 },
        { id: 'e5', titulo: 'Seletiva Games of the Future', mod: 'futebol', ano: 2024, local: 'Brasília, DF', fotos: 55 },
        { id: 'e6', titulo: 'Phygital Experience — Feira', mod: 'outros', ano: 2024, local: 'São Paulo, SP', fotos: 19 }
      ],

      parceiros: [
        { nome: 'Ministério do Esporte', tipo: 'Apoio institucional' },
        { nome: 'Confederação Brasileira', tipo: 'Apoio institucional' },
        { nome: 'Arena Nacional', tipo: 'Sede oficial' },
        { nome: 'TechSports', tipo: 'Patrocinador master' },
        { nome: 'EnergyDrink BR', tipo: 'Patrocinador' },
        { nome: 'GearPro', tipo: 'Fornecedor oficial' },
        { nome: 'StreamHub', tipo: 'Transmissão' },
        { nome: 'Instituto Movimento', tipo: 'Projeto social' }
      ],

      /* Dados do usuário logado (protótipo) */
      usuario: {
        nome: 'Diego Martins',
        email: 'diego@digitalsolvers.com',
        telefone: '(11) 98877-6655',
        criadoEm: '2026-07-02'
      },

      meusTimes: [
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
          id: 't2', nome: 'Alpha Squad BR', modalidade: 'shooter',
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
      ],

      minhasInscricoes: [
        { id: 'i1', campeonato: 'cbf-2026', time: 't1', protocolo: '2026-000418', status: 'oficial', data: '2026-08-03' },
        { id: 'i2', campeonato: 'cbs-2026', time: 't2', protocolo: '2026-000512', status: 'triagem', data: '2026-08-11' }
      ],

      chamados: [
        { id: 'c1', protocolo: '2026-000091', assunto: 'Troca de jogador após encerramento das inscrições',
          campeonato: 'cbf-2026', status: 'respondido', abertoEm: '2026-08-09', atualizadoEm: '2026-08-12',
          autor: 'Diego Martins',
          mensagens: [
            { de: 'usuario', autor: 'Diego Martins', texto: 'Preciso substituir o jogador Caio Ferreira por lesão. Já tenho o substituto cadastrado.', hora: '09/08/2026 14:22' },
            { de: 'sistema', texto: 'Chamado recebido — protocolo 2026-000091. Status: Aberto.', hora: '09/08/2026 14:22' },
            { de: 'org', autor: 'Organização Phygital', texto: 'Olá, Diego. Envie o atestado médico do atleta afastado para liberarmos a substituição.', hora: '12/08/2026 10:05' }
          ]},
        { id: 'c2', protocolo: '2026-000104', assunto: 'Dúvida sobre formato de foto dos atletas',
          campeonato: 'cbs-2026', status: 'encerrado', abertoEm: '2026-08-05', atualizadoEm: '2026-08-06',
          autor: 'Diego Martins',
          mensagens: [
            { de: 'usuario', autor: 'Diego Martins', texto: 'As fotos precisam ser em qual proporção?', hora: '05/08/2026 08:40' },
            { de: 'org', autor: 'Organização Phygital', texto: 'Proporção 3:4, mínimo 600x800px, JPG ou PNG até 5 MB.', hora: '06/08/2026 09:12' },
            { de: 'sistema', texto: 'Chamado encerrado pela organização.', hora: '06/08/2026 09:15' }
          ]}
      ],

      /* Admin */
      adminChamados: [
        { id: 'a1', protocolo: '2026-000091', assunto: 'Troca de jogador após encerramento', time: 'Tigres Phygital', campeonato: 'cbf-2026', status: 'respondido', abertoEm: '2026-08-09' },
        { id: 'a2', protocolo: '2026-000118', assunto: 'Erro ao subir logo do time', time: 'Fúria Digital', campeonato: 'cbf-2026', status: 'aberto', abertoEm: '2026-08-13' },
        { id: 'a3', protocolo: '2026-000121', assunto: 'Solicitação de cancelamento de inscrição', time: 'Litoral Gaming', campeonato: 'cbs-2026', status: 'aberto', abertoEm: '2026-08-14' },
        { id: 'a4', protocolo: '2026-000105', assunto: 'Confirmação de vaga na lista oficial', time: 'Cangaço 3x3', campeonato: 'cbb-2026', status: 'andamento', abertoEm: '2026-08-12' },
        { id: 'a5', protocolo: '2026-000104', assunto: 'Dúvida sobre formato de foto', time: 'Alpha Squad BR', campeonato: 'cbs-2026', status: 'encerrado', abertoEm: '2026-08-05' }
      ],

      adminUsuarios: [
        { id: 'u1', nome: 'Inscrições Phygital', email: 'inscricoes@phygitalgamesbr.com.br', telefone: '(11) 3000-0001', nivel: 'master', criadoEm: '2026-01-10' },
        { id: 'u2', nome: 'Ana Beatriz Lopes', email: 'ana@phygitalgamesbr.com.br', telefone: '(11) 3000-0002', nivel: 'gestor', criadoEm: '2026-03-22' },
        { id: 'u3', nome: 'Carlos Eduardo Pinto', email: 'carlos@phygitalgamesbr.com.br', telefone: '(11) 3000-0003', nivel: 'operacao', criadoEm: '2026-05-08' }
      ],

      banners: [
        { id: 'b1', titulo: 'Copa Phygital Futebol 2026', img: 'assets/img/mock/camp-futebol.svg', link: 'inscricoes.html', ordem: 1, ativo: true },
        { id: 'b2', titulo: 'Circuito Basquete 3x3', img: 'assets/img/mock/camp-basquete.svg', link: 'inscricoes.html', ordem: 2, ativo: true },
        { id: 'b3', titulo: 'Shooter Open — Temporada 2026', img: 'assets/img/mock/camp-shooter.svg', link: 'inscricoes.html', ordem: 3, ativo: true }
      ],

      emailsEnviados: [
        { id: 'em1', assunto: 'Confirmação de inscrição — Copa Phygital Futebol 2026', destino: 'Copa Phygital Futebol 2026', qtd: 18, data: '2026-08-03 09:14', status: 'entregue' },
        { id: 'em2', assunto: 'Encerramento das inscrições se aproxima', destino: 'Todos os campeonatos', qtd: 43, data: '2026-08-10 17:30', status: 'entregue' },
        { id: 'em3', assunto: 'Atualização do regulamento — Shooter Open', destino: 'Phygital Shooter Open', qtd: 14, data: '2026-08-12 11:02', status: 'entregue' }
      ],

      auditoria: [],

      /* A senha do SMTP fica em branco de propósito: este arquivo é público.
         No servidor ela vem de PHYGITAL_SMTP_SENHA e não é gravada no banco. */
      smtp: {
        email: 'inscricoes@phygitalgamesbr.com.br',
        senha: '',
        usuario: 'inscricoes@phygitalgamesbr.com.br',
        servidorEntrada: 'mail.phygitalgamesbr.com.br',
        imap: 993,
        pop3: 995,
        servidorSaida: 'mail.phygitalgamesbr.com.br',
        smtp: 465,
        seguranca: 'SSL',
        remetente: 'Phygital Brasil'
      },

      /* Categorias do blog — editáveis pelo administrador */
      categorias: [
        { id: 'campeonatos', nome: 'Campeonatos', descricao: 'Aberturas, calendário e resultados das etapas.', cor: '#009B4A' },
        { id: 'regulamento', nome: 'Regulamento', descricao: 'Regras, formato de disputa e critérios de classificação.', cor: '#0A66B1' },
        { id: 'institucional', nome: 'Institucional', descricao: 'Notícias da Phygital Brasil e representação internacional.', cor: '#FCE001' },
        { id: 'inscricoes', nome: 'Inscrições', descricao: 'Prazos, documentação e orientações para responsáveis.', cor: '#DF9911' },
        { id: 'eventos', nome: 'Eventos', descricao: 'Cobertura e retrospectiva das etapas realizadas.', cor: '#3D93D6' }
      ],

      /* Banners separados por onde aparecem.
         midia: 'imagem' | 'video' — vídeo usa o campo `video` como fonte.
         arquivado: true tira da rotação e joga para o histórico, sem apagar. */
      bannersSite: [
        { id: 's1', titulo: 'O físico e o digital no mesmo campo de jogo',
          texto: 'Cada confronto tem duas metades: uma no console, outra na quadra. O placar final é a soma das duas. É assim que a Phygital Brasil disputa futebol, basquete, dance e shooter em todo o país.',
          eyebrow: 'Temporada 2026',
          botao: 'Ver inscrições abertas', link: 'inscricoes.html',
          botao2: 'Como funciona', link2: 'quem-somos.html',
          midia: 'imagem', img: 'assets/img/mock/hero-1.svg', video: '',
          tituloTamanho: 0, semTexto: false, ordem: 1, ativo: true, arquivado: false },
        { id: 's2', titulo: 'Circuito Phygital Basquete 3x3',
          texto: 'Segunda edição do circuito, agora em Belo Horizonte, com 16 vagas e novo formato de classificação.',
          eyebrow: 'Inscrições abertas',
          botao: 'Inscrever time', link: 'inscricoes.html', botao2: '', link2: '',
          midia: 'imagem', img: 'assets/img/mock/hero-2.svg', video: '',
          tituloTamanho: 0, semTexto: false, ordem: 2, ativo: true, arquivado: false },
        { id: 's3', titulo: '', texto: '', eyebrow: '',
          botao: '', link: '', botao2: '', link2: '',
          midia: 'imagem', img: 'assets/img/mock/hero-3.svg', video: '',
          tituloTamanho: 0, semTexto: true, ordem: 3, ativo: true, arquivado: false }
      ],

      /* Regras aplicadas ao cálculo de cada ranking */
      rankingConfig: {
        futebol:  { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
        basquete: { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
        shooter:  { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true },
        dance:    { pontosVitoria: 3, pontosEmpate: 1, pontosDerrota: 0, bonusTitulo: 10, bonusGotf: 5, minCampeonatos: 1, ativo: true }
      },

      /* ---------------------------------------------------------------------
         MODELOS DE E-MAIL
         Todo alerta automático do site sai de um destes modelos. As variáveis
         entre chaves são trocadas pelo valor real no momento do envio.
         --------------------------------------------------------------------- */
      modelosEmail: [
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
      ],

      /* Variáveis que podem ser usadas nos modelos */
      variaveisEmail: [
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
      ]
    };
  }

  /* =====================================================================
     TRANSPORTE

     Duas portas para o mesmo back-end:
       pedirSync  — XMLHttpRequest síncrono, usado por PB.dados.*
       pedir      — fetch, usado por PB.api.* (assíncrono, devolve Promise)

     Nenhuma das duas lança: uma falha vira { ok: false, erro: '...' }, porque
     quem chama está no meio da montagem de uma tela e não pode quebrar.
     ===================================================================== */

  function urlDe(caminho) {
    return BASE + caminho;
  }

  function interpretar(status, texto) {
    var dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = null; }

    var httpOk = status >= 200 && status < 300;
    var ok = httpOk && !(dados && dados.ok === false);
    var erro = null;

    if (!ok) {
      erro = (dados && dados.erro) ||
             (status ? 'O servidor recusou a operação (HTTP ' + status + ').'
                     : 'Sem resposta do servidor.');
    }

    return { ok: ok, status: status, dados: dados, erro: erro };
  }

  /* XHR síncrono. O motivo está no cabeçalho do arquivo: as páginas leem
     PB.dados.* durante o parse e não têm como esperar uma Promise. */
  function pedirSync(metodo, caminho, corpo) {
    if (!global.XMLHttpRequest) return { ok: false, status: 0, dados: null, erro: 'Sem XMLHttpRequest.' };

    var req = new global.XMLHttpRequest();
    try {
      req.open(metodo, urlDe(caminho), false);   /* false = síncrono */
      req.setRequestHeader('Accept', 'application/json');
      if (corpo !== undefined && corpo !== null) {
        req.setRequestHeader('Content-Type', 'application/json');
      }
      req.send(corpo === undefined || corpo === null ? null : JSON.stringify(corpo));
    } catch (e) {
      /* Rede fora, CSP, porta errada, file:// — tudo cai aqui e vira modo local. */
      return { ok: false, status: 0, dados: null, erro: 'Não foi possível falar com o servidor.' };
    }

    return interpretar(req.status, req.responseText);
  }

  /* Versão assíncrona, base do PB.api.*. Resolve sempre; nunca rejeita. */
  function pedir(metodo, caminho, corpo) {
    if (!global.fetch) {
      return Promise.resolve({ ok: false, status: 0, dados: null, erro: 'Sem fetch neste navegador.' });
    }

    var opcoes = { method: metodo, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (corpo !== undefined && corpo !== null) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }

    return global.fetch(urlDe(caminho), opcoes)
      .then(function (resposta) {
        return resposta.text().then(function (texto) {
          return interpretar(resposta.status, texto);
        });
      })
      .catch(function () {
        return { ok: false, status: 0, dados: null, erro: 'Não foi possível falar com o servidor.' };
      });
  }

  /* Aviso ao usuário quando uma escrita não passou. phygital.js carrega depois
     deste arquivo, então PB.toast pode ainda não existir na primeira carga. */
  function avisar(mensagem) {
    if (global.PB && typeof global.PB.toast === 'function') {
      global.PB.toast('Não foi possível salvar', mensagem || 'Tente novamente em instantes.', 'erro');
    } else if (global.console && console.warn) {
      console.warn('[PB.dados] ' + mensagem);
    }
  }

  function clonar(valor) {
    return valor === undefined ? undefined : JSON.parse(JSON.stringify(valor));
  }

  /* Tira o item do array SEM trocar a referência: várias telas guardam a lista
     em uma variável e continuariam lendo o array antigo. */
  function retirar(lista, item) {
    var i = lista.indexOf(item);
    if (i >= 0) lista.splice(i, 1);
  }

  function ehAdmin() {
    return !!(_conta && _conta.papel === 'admin');
  }

  /* =====================================================================
     ROTAS POR COLEÇÃO

     Cada coleção do cache sabe onde gravar. `preparar` existe para as rotas
     que recusam campos extras — PUT /api/times/:id, por exemplo, devolve 400
     se o corpo trouxer o elenco junto.
     ===================================================================== */

  function apenas(item, campos) {
    var saida = {};
    campos.forEach(function (c) { if (item[c] !== undefined) saida[c] = item[c]; });
    return saida;
  }

  var ROTAS = {
    campeonatos: {
      caminho: '/campeonatos', chaveUm: 'campeonato', tabela: 'campeonatos', admin: true
    },
    posts: {
      caminho: '/posts', chaveUm: 'post', tabela: 'posts', admin: true, temHistorico: true
    },
    categorias: {
      caminho: '/categorias', chaveUm: 'categoria', tabela: 'categorias', admin: true, temHistorico: true
    },
    eventos: {
      caminho: '/eventos', chaveUm: 'evento', tabela: 'eventos', admin: true, temHistorico: true
    },
    parceiros: {
      caminho: '/parceiros', chaveUm: 'parceiro', tabela: 'parceiros', admin: true, temHistorico: true
    },
    banners: {
      caminho: '/banners', chaveUm: 'banner', tabela: 'banners', admin: true, temHistorico: true
    },
    bannersSite: {
      caminho: '/banners-site', chaveUm: 'bannerSite', chaveLista: 'bannersSite',
      tabela: 'banners_site', admin: true, temHistorico: true
    },
    adminUsuarios: {
      caminho: '/admin/usuarios', chaveUm: 'usuario', tabela: 'contas', admin: true,
      preparar: function (u) { return apenas(u, ['nome', 'email', 'telefone', 'nivel']); }
    },
    meusTimes: {
      caminho: '/times', chaveUm: 'time', tabela: 'times',
      /* O elenco tem rotas próprias (/times/:id/jogadores); mandá-lo aqui é 400. */
      preparar: function (t) { return apenas(t, ['nome', 'categoria', 'escudo', 'descricao', 'historico']); }
    },
    minhasInscricoes: {
      caminho: '/inscricoes', chaveUm: 'inscricao', semGravacao: true
    },
    modelosEmail: {
      caminho: '/email/modelos', chaveUm: 'modelo', admin: true, semCriacao: true,
      preparar: function (m) { return apenas(m, ['grupo', 'nome', 'quando', 'assunto', 'corpo', 'ativo']); }
    }
  };

  /* Coleções que o sincronizar() compara com o espelho. Ficam de fora as que
     não têm rota de escrita (resultados, auditoria, emailsEnviados) e as que
     têm porta própria (chamados, minhasInscricoes). */
  var COLECOES_SINCRONIZADAS = [
    'campeonatos', 'posts', 'categorias', 'eventos', 'parceiros',
    'banners', 'bannersSite', 'adminUsuarios', 'meusTimes', 'modelosEmail'
  ];

  /* =====================================================================
     DESCOBERTA E HIDRATAÇÃO
     ===================================================================== */

  /* ---------------------------------------------------------------------
     IDIOMA DA CARGA

     O /api/bootstrap devolve o conteúdo cadastrado já traduzido, e quem decide
     o idioma é o servidor. Se ninguém disser nada, ele decide pelo cookie — que
     na primeira carga ainda é o da navegação ANTERIOR, porque quem grava o
     cookie novo é o i18n.js. Era essa a origem da tela atrasada um carregamento
     inteiro: abrir ?lang=en mostrava o conteúdo em português, e ?lang=es depois
     mostrava o inglês.

     Por isso o i18n.js passou a ser carregado ANTES deste arquivo nas 50
     páginas: quando a linha abaixo roda, o idioma da URL já foi resolvido e
     gravado, e viaja no ?lang= da requisição.

     O parâmetro só viaja quando é ESCOLHA — ?lang na URL, cookie ou clique no
     seletor. Quando o i18n apenas chutou pelo navegador, fica de fora de
     propósito: o servidor tem uma pista melhor, que o front-end não enxerga
     antes do bootstrap, que é a preferência gravada na conta. O idioma que ele
     escolheu volta no corpo, e o i18n.js se alinha a ele quando o DOM fica
     pronto.

     Sem o i18n.js na página (GitHub Pages, página avulsa) nada disso acontece e
     a requisição sai exatamente como saía antes.
     --------------------------------------------------------------------- */

  function idiomaEscolhido() {
    var i18n = global.PB && global.PB.i18n;
    if (!i18n || typeof i18n.escolhido !== 'function') return null;
    try { return i18n.escolhido(); } catch (e) { return null; }
  }

  function comIdioma(caminho) {
    var codigo = idiomaEscolhido();
    if (!codigo) return caminho;
    return caminho + (caminho.indexOf('?') >= 0 ? '&' : '?')
      + 'lang=' + encodeURIComponent(codigo);
  }

  /* /api/ping é a pergunta "existe back-end aqui?". Em GitHub Pages responde
     404, em file:// nem chega a sair — os dois caem no modo local. */
  function descobrir() {
    if (!global.XMLHttpRequest) return false;
    if (global.location && global.location.protocol === 'file:') return false;

    var r = pedirSync('GET', '/ping');
    return !!(r.ok && r.dados && r.dados.modo === 'api');
  }

  /* Uma chamada enche o cache inteiro. O payload DEPENDE DA SESSÃO: sem login
     vem só conteúdo público, com login vêm os próprios times, inscrições e
     chamados. Por isso todo login e todo logout precisa passar por aqui. */
  function hidratar() {
    var r = pedirSync('GET', comIdioma('/bootstrap'));
    if (!r.ok || !r.dados || !r.dados.dados) return false;

    _cache = r.dados.dados;
    _conta = r.dados.conta || null;

    /* Em que idioma o servidor traduziu ESTE payload. É o que o i18n.js lê para
       alinhar a interface ao conteúdo quando quem decidiu foi o servidor. */
    _idiomaResolvido = r.dados.idioma || null;

    /* As regras de elenco passam a ser as do servidor: uma cópia divergente no
       cliente deixaria o formulário aceitar o que a API recusa. */
    if (r.dados.modalidades && typeof r.dados.modalidades === 'object') {
      MODALIDADES = r.dados.modalidades;
      api.MODALIDADES = MODALIDADES;
    }

    _arquivados = null;
    fotografar();
    return true;
  }

  /* =====================================================================
     PERSISTÊNCIA
     ===================================================================== */

  function carregar() {
    if (_cache) return _cache;

    if (_modo === 'api') {
      if (hidratar()) return _cache;
      _modo = 'local';   /* o servidor sumiu no meio da navegação */
    }

    try {
      var bruto = global.localStorage && localStorage.getItem(CHAVE);
      _cache = bruto ? JSON.parse(bruto) : semente();
    } catch (e) {
      _cache = semente();
    }
    return _cache;
  }

  /** @returns {boolean} true quando tudo foi gravado. */
  function salvar() {
    if (_modo === 'api') return sincronizar();
    try {
      if (global.localStorage) localStorage.setItem(CHAVE, JSON.stringify(_cache));
    } catch (e) { /* modo privado / cota — segue em memória */ }
    return true;
  }

  function resetar() {
    if (_modo === 'api') {
      /* O servidor é a fonte: aqui "resetar" significa descartar o que está em
         memória e buscar tudo de novo. Recriar a base é `node server/semente.js`. */
      recarregar();
      return _cache;
    }
    _cache = semente();
    salvar();
    return _cache;
  }

  function recarregar() {
    if (_modo === 'api') return hidratar();
    _cache = null;
    carregar();
    return true;
  }

  /* =====================================================================
     ESPELHO E SINCRONIZAÇÃO

     Várias telas editam o cache direto (D.tudo() ... D.salvar()) em vez de
     chamar D.gravar(). Para essas, salvar() precisa descobrir sozinho o que
     mudou: o espelho é a foto do cache logo depois da última gravação bem
     sucedida, e a diferença entre ele e o cache atual é exatamente o que
     precisa subir para a API.
     ===================================================================== */

  function fotografar() {
    if (_modo !== 'api' || !_cache) { _espelho = null; return; }

    var foto = { colecoes: {}, ranking: {}, rankingConfig: {}, smtp: '' };

    COLECOES_SINCRONIZADAS.forEach(function (nome) {
      var itens = {};
      (_cache[nome] || []).forEach(function (item) {
        if (item && item.id !== undefined && item.id !== null) {
          itens[item.id] = JSON.stringify(item);
        }
      });
      foto.colecoes[nome] = itens;
    });

    Object.keys(_cache.ranking || {}).forEach(function (mod) {
      foto.ranking[mod] = JSON.stringify(_cache.ranking[mod]);
    });
    Object.keys(_cache.rankingConfig || {}).forEach(function (mod) {
      foto.rankingConfig[mod] = JSON.stringify(_cache.rankingConfig[mod]);
    });
    foto.smtp = JSON.stringify(_cache.smtp || {});

    _espelho = foto;
  }

  /* Devolve o item da coleção ao estado em que o espelho o guardou. */
  function desfazerItem(colecao, id) {
    if (!_espelho || !_espelho.colecoes[colecao]) return;
    var anterior = _espelho.colecoes[colecao][id];
    if (anterior === undefined) return;

    var lista = _cache[colecao] || [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i] && lista[i].id === id) { lista[i] = JSON.parse(anterior); return; }
    }
  }

  function corpoDe(rota, item) {
    return rota.preparar ? rota.preparar(item) : item;
  }

  function sincronizar() {
    /* true, não vazio: salvar() repassa este retorno, e sair sem valor faria uma
       sincronização que nada tinha a enviar ser lida como recusa pela tela. */
    if (_modo !== 'api' || !_cache) return true;
    if (!_espelho) { fotografar(); return true; }

    var falhas = [];

    COLECOES_SINCRONIZADAS.forEach(function (colecao) {
      var rota = ROTAS[colecao];
      if (!rota || rota.semGravacao) return;
      if (rota.admin && !ehAdmin()) return;   /* sem permissão: fica só no cache */

      var antes = _espelho.colecoes[colecao] || {};

      (_cache[colecao] || []).forEach(function (item) {
        if (!item || item.id === undefined || item.id === null) return;

        var agora = JSON.stringify(item);
        /* Item novo é criação e sai por gravar(); aqui só o que já existia. */
        if (antes[item.id] === undefined || antes[item.id] === agora) return;

        var r = pedirSync('PUT', rota.caminho + '/' + encodeURIComponent(item.id), corpoDe(rota, item));
        if (r.ok) absorver(colecao, r.dados);
        else { desfazerItem(colecao, item.id); falhas.push(r.erro); }
      });
    });

    if (ehAdmin()) {
      Object.keys(_cache.ranking || {}).forEach(function (mod) {
        var agora = JSON.stringify(_cache.ranking[mod]);
        if (_espelho.ranking[mod] === undefined || _espelho.ranking[mod] === agora) return;

        /* A lista inteira sobe junto: a tela tanto corrige uma linha quanto
           reordena o pódio, e { linhas } cobre os dois casos. */
        var r = pedirSync('PUT', '/ranking/' + encodeURIComponent(mod), { linhas: _cache.ranking[mod] });
        if (!r.ok) { _cache.ranking[mod] = JSON.parse(_espelho.ranking[mod]); falhas.push(r.erro); }
      });

      Object.keys(_cache.rankingConfig || {}).forEach(function (mod) {
        var agoraCfg = JSON.stringify(_cache.rankingConfig[mod]);
        if (_espelho.rankingConfig[mod] === undefined || _espelho.rankingConfig[mod] === agoraCfg) return;

        var rc = pedirSync('PUT', '/ranking-config/' + encodeURIComponent(mod), _cache.rankingConfig[mod]);
        if (!rc.ok) { _cache.rankingConfig[mod] = JSON.parse(_espelho.rankingConfig[mod]); falhas.push(rc.erro); }
      });

      var agoraSmtp = JSON.stringify(_cache.smtp || {});
      if (_espelho.smtp !== agoraSmtp) {
        var rs = pedirSync('PUT', '/email/smtp', _cache.smtp || {});
        if (rs.ok) { if (rs.dados && rs.dados.smtp) _cache.smtp = rs.dados.smtp; }
        else { _cache.smtp = JSON.parse(_espelho.smtp); falhas.push(rs.erro); }
      }
    }

    if (falhas.length) avisar(falhas[0]);
    fotografar();

    /* Devolve se TUDO passou. Sem retorno, as telas que gravam por
       tudo() + salvar() não tinham como distinguir sucesso de recusa e
       comemoravam sempre. */
    return falhas.length === 0;
  }

  /* Troca o item do cache pelo que o servidor devolveu (ids gerados, carimbos
     de data, contadores derivados). Devolve o item já no cache. */
  function absorver(colecao, resposta, idOtimista) {
    var rota = ROTAS[colecao];
    var vindo = rota && rota.chaveUm && resposta ? resposta[rota.chaveUm] : null;
    if (!vindo) return null;

    var lista = _cache[colecao] || (_cache[colecao] = []);
    var alvo = idOtimista === undefined ? vindo.id : idOtimista;

    for (var i = 0; i < lista.length; i++) {
      if (lista[i] && lista[i].id === alvo) { lista[i] = vindo; return vindo; }
    }
    lista.push(vindo);
    return vindo;
  }

  /* =====================================================================
     CONSULTAS E ESCRITAS
     ===================================================================== */
  var api = {
    MODALIDADES: MODALIDADES,
    STATUS_INSCRICAO: STATUS_INSCRICAO,
    STATUS_CHAMADO: STATUS_CHAMADO,
    STATUS_CAMPEONATO: STATUS_CAMPEONATO,
    TIPOS_DOCUMENTO: TIPOS_DOCUMENTO,
    STATUS_DOCUMENTO: STATUS_DOCUMENTO,
    CONTAS: CONTAS,

    /** 'api' quando há back-end, 'local' quando o site é só estático. */
    modo: function () { return _modo; },

    /**
     * Idioma em que o servidor traduziu o conteúdo que está em cache agora.
     * null no modo local, onde a semente é sempre a portuguesa.
     */
    idiomaResolvido: function () { return _idiomaResolvido; },

    /**
     * Busca o payload de novo no servidor, no idioma vigente — o ?lang= sai
     * junto, então trocar de idioma e recarregar traz o conteúdo já traduzido.
     * No modo local, relê o localStorage.
     */
    recarregar: recarregar,

    /* -------------------------------------------------------------------
       DOCUMENTOS
       ------------------------------------------------------------------- */

    /* Documentos exigidos de um jogador, já com o status de cada um.
       Considera a idade: a autorização do responsável só vale para menores. */
    documentosDoJogador: function (jogador) {
      var hoje = new Date();
      var idade = null;
      if (jogador && jogador.nasc) {
        var n = new Date(jogador.nasc + 'T00:00:00');
        idade = hoje.getFullYear() - n.getFullYear();
        var m = hoje.getMonth() - n.getMonth();
        if (m < 0 || (m === 0 && hoje.getDate() < n.getDate())) idade--;
      }

      var enviados = (jogador && jogador.documentos) || [];

      return Object.keys(TIPOS_DOCUMENTO).map(function (id) {
        var tipo = TIPOS_DOCUMENTO[id];
        if (tipo.apenasMenores && (idade === null || idade >= 18)) return null;

        var doc = enviados.filter(function (d) { return d.tipo === id; })[0];
        var status = doc ? (doc.status || 'enviado') : 'pendente';

        /* Documento com validade no passado vira "vencido", mesmo aprovado */
        if (doc && tipo.temValidade && doc.validade) {
          var v = new Date(doc.validade + 'T00:00:00');
          if (v < hoje) status = 'vencido';
        }

        return {
          tipo: id,
          nome: tipo.nome,
          descricao: tipo.descricao,
          obrigatorio: tipo.obrigatorio || (tipo.apenasMenores && idade !== null && idade < 18),
          temValidade: tipo.temValidade,
          arquivo: doc ? doc.arquivo : null,
          validade: doc ? doc.validade : null,
          observacao: doc ? doc.observacao : null,
          status: status
        };
      }).filter(Boolean);
    },

    /* Resumo da documentação de um time: quantos faltam e o que trava */
    documentacaoDoTime: function (time) {
      if (!time) return { total: 0, ok: 0, pendencias: [], completo: true };
      var pendencias = [], total = 0, ok = 0;

      (time.jogadores || []).forEach(function (j) {
        api.documentosDoJogador(j).forEach(function (d) {
          if (!d.obrigatorio) return;
          total++;
          if (d.status === 'aprovado') { ok++; return; }
          pendencias.push({
            jogador: j.nome, documento: d.nome, status: d.status,
            rotulo: (STATUS_DOCUMENTO[d.status] || STATUS_DOCUMENTO.pendente).rotulo
          });
        });
      });

      return { total: total, ok: ok, pendencias: pendencias, completo: pendencias.length === 0 };
    },

    /* Registra ou atualiza um documento do jogador.
       No modo api há duas portas: o competidor ENVIA o arquivo, o administrador
       CONFERE (aprova ou recusa) — são rotas diferentes porque são permissões
       diferentes. */
    gravarDocumento: function (timeId, indiceJogador, doc) {
      var d = carregar();
      var time = (d.meusTimes || []).filter(function (t) { return t.id === timeId; })[0];
      if (!time) return false;
      var j = (time.jogadores || [])[indiceJogador];
      if (!j) return false;

      j.documentos = j.documentos || [];
      var atual = j.documentos.filter(function (x) { return x.tipo === doc.tipo; })[0];
      var antes = atual ? clonar(atual) : null;

      if (atual) {
        Object.keys(doc).forEach(function (k) { atual[k] = doc[k]; });
      } else {
        j.documentos.push(doc);
      }

      if (_modo === 'api') {
        var conferencia = doc.status === 'aprovado' || doc.status === 'recusado';
        var r;

        if (conferencia) {
          var documentoId = (atual && atual.id) || (j.id ? j.id + '-' + doc.tipo : null);
          r = documentoId
            ? pedirSync('POST', '/documentos/' + encodeURIComponent(documentoId) + '/conferir',
                        { status: doc.status, observacao: doc.observacao || '' })
            : { ok: false, erro: 'Documento ainda não enviado — não há o que conferir.' };
        } else {
          r = pedirSync(
            'PUT',
            '/times/' + encodeURIComponent(timeId) +
            '/jogadores/' + encodeURIComponent(j.id) +
            '/documentos/' + encodeURIComponent(doc.tipo),
            { arquivo: doc.arquivo, validade: doc.validade || null }
          );
        }

        if (!r.ok) {
          /* Desfaz: repõe o documento anterior ou tira o que acabou de entrar. */
          if (antes && atual) Object.keys(atual).forEach(function (k) { atual[k] = antes[k]; });
          else j.documentos = j.documentos.filter(function (x) { return x !== doc; });
          avisar(r.erro);
          return false;
        }

        if (r.dados && r.dados.documento) {
          var salvo = r.dados.documento;
          var alvo = j.documentos.filter(function (x) { return x.tipo === salvo.tipo; })[0];
          if (alvo) Object.keys(salvo).forEach(function (k) { alvo[k] = salvo[k]; });
        }
        fotografar();
      } else {
        salvar();
      }

      api.registrar('documento', time.nome,
        doc.status === 'aprovado' ? 'aprovou' : doc.status === 'recusado' ? 'recusou' : 'enviou',
        j.nome + ' · ' + (TIPOS_DOCUMENTO[doc.tipo] || {}).nome);
      return true;
    },

    tudo: carregar,
    salvar: salvar,
    resetar: resetar,

    /* -------------------------------------------------------------------
       AUTENTICAÇÃO
       ------------------------------------------------------------------- */

    /* Mesmo retorno nos dois modos: { ok: true, conta } ou { ok: false, erro }.
       A conta traz `destino`, que é para onde a tela de login redireciona. */
    autenticar: function (email, senha) {
      if (_modo === 'api') {
        var r = pedirSync('POST', '/auth/login', { email: email, senha: senha });
        if (!r.ok || !r.dados || !r.dados.conta) {
          return { ok: false, erro: r.erro || 'Não foi possível entrar.' };
        }

        /* CRÍTICO: o bootstrap depende da sessão. Sem esta recarga o usuário
           entra no painel e não enxerga os próprios times — o cache ainda é o
           payload público que veio antes do login. */
        hidratar();

        return { ok: true, conta: r.dados.conta };
      }

      var e = String(email || '').trim().toLowerCase();
      var conta = CONTAS.filter(function (c) { return c.email.toLowerCase() === e; })[0];
      if (!conta) return { ok: false, erro: 'E-mail não encontrado.' };
      if (conta.senha !== senha) return { ok: false, erro: 'Senha incorreta.' };
      return { ok: true, conta: conta };
    },

    /* No modo api não faz nada: o cookie de sessão já veio na resposta do
       login, com HttpOnly, e guardar uma cópia em localStorage só criaria uma
       segunda fonte de verdade para desencontrar da primeira. */
    abrirSessao: function (conta) {
      if (_modo === 'api') return;
      try {
        global.localStorage.setItem(CHAVE_SESSAO, JSON.stringify({
          email: conta.email, papel: conta.papel, nome: conta.nome, nivel: conta.nivel
        }));
      } catch (e) { /* modo privado */ }
    },

    sessao: function () {
      if (_modo === 'api') {
        if (!_conta) return null;
        return {
          email: _conta.email, papel: _conta.papel,
          nome: _conta.nome, nivel: _conta.nivel
        };
      }
      try {
        var b = global.localStorage.getItem(CHAVE_SESSAO);
        return b ? JSON.parse(b) : null;
      } catch (e) { return null; }
    },

    encerrarSessao: function () {
      if (_modo === 'api') {
        pedirSync('POST', '/auth/logout', {});
        _conta = null;
        /* Mesma razão do login: sem rehidratar, o cache seguiria com os dados
           da conta que acabou de sair. */
        hidratar();
        return;
      }
      try { global.localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
    },

    /* -------------------------------------------------------------------
       GRAVAÇÃO — usado pelas telas de edição. Persiste e devolve o item.
       ------------------------------------------------------------------- */
    gravar: function (colecao, item, chave) {
      chave = chave || 'id';
      var d = carregar();
      if (!d[colecao]) d[colecao] = [];

      var i = d[colecao].map(function (x) { return x[chave]; }).indexOf(item[chave]);
      var existia = i >= 0;
      var antes = existia ? clonar(d[colecao][i]) : null;

      if (existia) {
        /* merge: preserva campos que a tela de edição não envia */
        Object.keys(item).forEach(function (k) { d[colecao][i][k] = item[k]; });
      } else {
        d[colecao].push(item);
      }

      if (_modo !== 'api') { salvar(); return item; }

      var rota = ROTAS[colecao];

      /* O disparo de e-mail tem porta própria: gravar('emailsEnviados', …) é a
         forma como a tela pede o envio, e o histórico é consequência dele. */
      if (colecao === 'emailsEnviados') {
        dispararEmailDoRegistro(item);
        fotografar();
        return item;
      }

      /* Coleção sem rota (resultados, auditoria) ou escrita que esta sessão não
         tem permissão de fazer: fica no cache até a próxima rehidratação. É o
         caso de painel/inscricoes.html, que decrementa o contador do
         campeonato só para a tela não piscar — quem manda no número é o
         servidor, que recalcula a partir das inscrições. */
      if (!rota || rota.semGravacao || (rota.admin && !ehAdmin())) {
        fotografar();
        return item;
      }

      var id = d[colecao][existia ? i : d[colecao].length - 1][chave];
      var atual = existia ? d[colecao][i] : item;
      var r;

      if (existia || rota.semCriacao) {
        r = pedirSync('PUT', rota.caminho + '/' + encodeURIComponent(id), corpoDe(rota, atual));
      } else {
        r = pedirSync('POST', rota.caminho, corpoDe(rota, atual));
      }

      if (!r.ok) {
        /* Desfaz no próprio array: as telas guardam a referência da lista, e
           trocá-la por outra deixaria a página lendo a versão antiga. */
        if (existia) d[colecao][i] = antes;
        else retirar(d[colecao], item);
        avisar(r.erro);
        /* FALSO, não o item. Devolver o item aqui — igual ao sucesso — deixava
           a tela sem como saber que o servidor recusou: aparecia o aviso de erro
           E o toast verde de "salvo", e algumas telas ainda navegavam para uma
           lista onde o registro não existe. */
        return false;
      }

      absorver(colecao, r.dados, id);
      fotografar();
      return item;
    },

    /* -------------------------------------------------------------------
       HISTÓRICO (exclusão em duas etapas)
       Nada some da base num clique só: `arquivar` tira o item de circulação
       e guarda no histórico; de lá ele volta com `restaurar` ou é apagado de
       vez com `excluirDefinitivo`. Vale para banners, posts, categorias,
       usuários, times, campeonatos e inscrições.
       ------------------------------------------------------------------- */
    arquivar: function (colecao, valor, chave, motivo) {
      chave = chave || 'id';
      var d = carregar();
      var item = (d[colecao] || []).filter(function (x) { return x[chave] === valor; })[0];
      if (!item) return false;

      var antes = clonar(item);

      item.arquivado = true;
      item.arquivadoEm = new Date().toISOString().slice(0, 16).replace('T', ' ');
      if (motivo) item.arquivadoMotivo = motivo;

      if (_modo !== 'api') { salvar(); return true; }

      var rota = ROTAS[colecao];
      if (!rota || (rota.admin && !ehAdmin())) { fotografar(); return true; }

      /* DELETE no servidor é arquivamento lógico, igual ao daqui. */
      var r = pedirSync('DELETE', rota.caminho + '/' + encodeURIComponent(valor),
                        motivo ? { observacao: motivo } : {});

      if (!r.ok) {
        Object.keys(item).forEach(function (k) { delete item[k]; });
        Object.keys(antes).forEach(function (k) { item[k] = antes[k]; });
        avisar(r.erro);
        return false;
      }

      absorver(colecao, r.dados, valor);
      _arquivados = null;
      fotografar();
      return true;
    },

    restaurar: function (colecao, valor, chave) {
      chave = chave || 'id';
      var d = carregar();

      if (_modo === 'api') {
        var rotaR = ROTAS[colecao];
        if (!rotaR || !rotaR.tabela) return false;

        var rr = pedirSync('POST', '/historico/restaurar', { tabela: rotaR.tabela, id: valor });
        if (!rr.ok) { avisar(rr.erro); return false; }

        _arquivados = null;
        hidratar();     /* o item volta para as listas — o payload inteiro muda */
        return true;
      }

      var item = (d[colecao] || []).filter(function (x) { return x[chave] === valor; })[0];
      if (!item) return false;
      delete item.arquivado;
      delete item.arquivadoEm;
      delete item.arquivadoMotivo;
      salvar();
      return true;
    },

    /* Só esta função apaga de verdade — e sempre atrás de confirmação. */
    excluirDefinitivo: function (colecao, valor, chave) {
      chave = chave || 'id';
      var d = carregar();

      if (_modo === 'api') {
        var rotaE = ROTAS[colecao];
        if (!rotaE || !rotaE.tabela) return false;

        var re = pedirSync('DELETE', '/historico', { tabela: rotaE.tabela, id: valor });
        if (!re.ok) { avisar(re.erro); return false; }

        if (d[colecao]) {
          var alvo = d[colecao].filter(function (x) { return x[chave] === valor; })[0];
          if (alvo) retirar(d[colecao], alvo);
        }
        _arquivados = null;
        fotografar();
        return true;
      }

      if (!d[colecao]) return false;
      var i = d[colecao].map(function (x) { return x[chave]; }).indexOf(valor);
      if (i < 0) return false;
      d[colecao].splice(i, 1);
      salvar();
      return true;
    },

    /* Itens no histórico de uma coleção.
       No modo api o bootstrap traz só o que está em circulação, então o
       histórico é consultado sob demanda — e memorizado, porque a tela de
       histórico chama esta função uma vez por coleção a cada render. */
    arquivados: function (colecao) {
      if (_modo !== 'api') {
        return (carregar()[colecao] || []).filter(function (x) { return x.arquivado; });
      }

      carregar();
      if (!_arquivados) _arquivados = {};
      if (_arquivados[colecao]) return _arquivados[colecao];

      var rota = ROTAS[colecao];
      var lista = (_cache[colecao] || []).filter(function (x) { return x.arquivado; });

      if (rota && rota.temHistorico) {
        /* Recursos de conteúdo devolvem o registro completo. */
        var r = pedirSync('GET', rota.caminho + '?arquivados=1');
        var chaveLista = rota.chaveLista || colecao;
        if (r.ok && r.dados && r.dados[chaveLista]) lista = r.dados[chaveLista];
      } else if (rota && rota.tabela) {
        /* Campeonatos, times e contas não têm listagem de arquivados: o que dá
           para mostrar vem de /api/historico, que devolve id, nome e data. */
        var h = pedirSync('GET', '/historico?tabela=' + encodeURIComponent(rota.tabela));
        if (h.ok && h.dados && h.dados.itens) {
          lista = h.dados.itens.map(function (it) {
            return {
              id: it.id, nome: it.nome, titulo: it.nome,
              arquivado: true, arquivadoEm: it.data
            };
          });
        }
      }

      _arquivados[colecao] = lista;
      return lista;
    },

    /* Itens em circulação (o que as telas listam por padrão) */
    ativos: function (colecao) {
      return (carregar()[colecao] || []).filter(function (x) { return !x.arquivado; });
    },

    /* Mantido por compatibilidade: agora arquiva em vez de apagar */
    remover: function (colecao, valor, chave) {
      return api.arquivar(colecao, valor, chave);
    },

    definir: function (caminho, valor) {
      var d = carregar();
      var antes = clonar(d[caminho]);
      d[caminho] = valor;

      if (_modo !== 'api') { salvar(); return valor; }

      /* Só a configuração de SMTP tem porta direta; o resto que passa por aqui
         não tem rota própria e fica no cache até a próxima rehidratação. */
      if (caminho === 'smtp' && ehAdmin()) {
        var r = pedirSync('PUT', '/email/smtp', valor);
        /* FALSO no fracasso. Devolver `antes` — um objeto, portanto truthy —
           deixava admin/email.html sem como saber que o servidor recusou: a tela
           mostrava o erro E "Configurações salvas" logo em seguida. */
        if (!r.ok) { d[caminho] = antes; avisar(r.erro); return false; }
        if (r.dados && r.dados.smtp) d.smtp = r.dados.smtp;
      }

      fotografar();
      return d[caminho];
    },

    modalidade: function (id) { return MODALIDADES[id] || MODALIDADES.outros; },

    campeonatos: function (filtro) {
      /* Arquivados ficam fora de toda listagem — só o histórico os mostra */
      var lista = carregar().campeonatos.filter(function (c) { return !c.arquivado; });
      if (!filtro) return lista;
      if (filtro.status) lista = lista.filter(function (c) { return c.status === filtro.status; });
      if (filtro.modalidade) lista = lista.filter(function (c) { return c.modalidade === filtro.modalidade; });
      return lista;
    },

    /* Inscrições abertas — a home só exibe a seção se este array tiver itens */
    inscricoesAbertas: function () {
      return carregar().campeonatos.filter(function (c) { return c.status === 'inscricoes'; });
    },

    campeonato: function (id) {
      return carregar().campeonatos.filter(function (c) { return c.id === id; })[0] || null;
    },

    ranking: function (mod) { return (carregar().ranking[mod] || []).slice(); },

    resultados: function (n) {
      var l = (carregar().resultados || []).slice();
      return n ? l.slice(0, n) : l;
    },

    posts: function (n) {
      var l = carregar().posts.filter(function (p) { return !p.arquivado; })
                .sort(function (a, b) { return a.data < b.data ? 1 : -1; });
      return n ? l.slice(0, n) : l;
    },
    post: function (id) { return carregar().posts.filter(function (p) { return p.id === id; })[0] || null; },

    eventos: function (mod) {
      var l = carregar().eventos.slice();
      return mod && mod !== 'todos' ? l.filter(function (e) { return e.mod === mod; }) : l;
    },

    parceiros: function () { return carregar().parceiros.slice(); },
    /* Nunca devolve null. No cliente antigo `usuario` era sempre o objeto da
       semente, então as páginas leem usuario().nome e usuario().email direto,
       sem checar. Sem sessão o bootstrap manda null, e seis telas quebravam com
       TypeError logo na primeira linha — inclusive verificar-email.html, que o
       cadastro abre justamente antes de existir sessão. Um objeto vazio mantém
       o contrato de forma e deixa a página renderizar em branco, que é o
       comportamento correto para quem ainda não entrou. */
    usuario: function () {
      return carregar().usuario || { nome: '', email: '', telefone: '', criadoEm: '' };
    },
    meusTimes: function () {
      return carregar().meusTimes.filter(function (t) { return !t.arquivado; });
    },
    time: function (id) { return carregar().meusTimes.filter(function (t) { return t.id === id; })[0] || null; },
    minhasInscricoes: function () {
      return (carregar().minhasInscricoes || []).filter(function (i) { return !i.arquivado; });
    },
    chamados: function () { return carregar().chamados.slice(); },
    chamado: function (id) { return carregar().chamados.filter(function (c) { return c.id === id; })[0] || null; },
    adminChamados: function (status) {
      var l = carregar().adminChamados.slice();
      if (status === 'abertos') return l.filter(function (c) { return c.status !== 'encerrado'; });
      if (status === 'encerrados') return l.filter(function (c) { return c.status === 'encerrado'; });
      return l;
    },
    adminUsuarios: function () {
      return carregar().adminUsuarios.filter(function (u) { return !u.arquivado; });
    },
    banners: function () {
      return carregar().banners.filter(function (b) { return !b.arquivado; })
               .sort(function (a, b) { return a.ordem - b.ordem; });
    },
    bannersSite: function () {
      return (carregar().bannersSite || []).slice().sort(function (a, b) { return a.ordem - b.ordem; });
    },
    emailsEnviados: function () { return carregar().emailsEnviados.slice(); },
    smtp: function () { return carregar().smtp; },
    categorias: function () {
      return (carregar().categorias || []).filter(function (c) { return !c.arquivado; });
    },
    categoria: function (id) {
      return (carregar().categorias || []).filter(function (c) { return c.id === id || c.nome === id; })[0] || null;
    },
    rankingConfig: function (mod) {
      var cfg = carregar().rankingConfig || {};
      return mod ? cfg[mod] : cfg;
    },

    /* Atualiza um chamado nas duas listas (usuário e admin).
       O mesmo protocolo aparece nas duas, então a conversa precisa ser uma só:
       a lista mais completa vira a base e o array é compartilhado pelos dois
       registros — senão cada lado enxerga metade das mensagens. */
    atualizarChamado: function (protocolo, mudancas) {
      var d = carregar();
      var alvos = [];
      ['chamados', 'adminChamados'].forEach(function (col) {
        (d[col] || []).forEach(function (c) {
          if (c.protocolo === protocolo) alvos.push(c);
        });
      });
      if (!alvos.length) return false;

      var estadoAnterior = alvos.map(function (c) { return clonar(c); });

      var conversa = alvos.reduce(function (maior, c) {
        return (c.mensagens && c.mensagens.length > (maior ? maior.length : 0)) ? c.mensagens : maior;
      }, null) || [];

      if (mudancas.mensagem) conversa.push(mudancas.mensagem);

      alvos.forEach(function (c) {
        c.mensagens = conversa;
        Object.keys(mudancas).forEach(function (k) {
          if (k !== 'mensagem') c[k] = mudancas[k];
        });
      });

      if (_modo !== 'api') { salvar(); return true; }

      var falha = null;

      if (mudancas.mensagem && mudancas.mensagem.texto) {
        var rm = pedirSync('POST', '/chamados/' + encodeURIComponent(protocolo) + '/mensagens',
                           { texto: mudancas.mensagem.texto });
        if (!rm.ok) falha = rm.erro;
      }

      /* Mudar o status é ato da organização: a rota exige administrador. Para o
         competidor, o próprio servidor ajusta o status ao receber a mensagem
         (respondido → em andamento), então não há nada a enviar daqui. */
      if (!falha && mudancas.status && ehAdmin()) {
        var rs = pedirSync('POST', '/chamados/' + encodeURIComponent(protocolo) + '/status',
                           { status: mudancas.status });
        if (!rs.ok) falha = rs.erro;
      }

      if (falha) {
        alvos.forEach(function (c, i) {
          Object.keys(c).forEach(function (k) { delete c[k]; });
          Object.keys(estadoAnterior[i]).forEach(function (k) { c[k] = estadoAnterior[i][k]; });
        });
        avisar(falha);
        return false;
      }

      /* Relê o chamado para o cache ficar com a verdade do servidor: status
         derivado, carimbos e a mensagem de sistema que ele mesmo inseriu. */
      var rl = pedirSync('GET', '/chamados/' + encodeURIComponent(protocolo));
      if (rl.ok && rl.dados) {
        var atualizado = rl.dados.chamado || rl.dados.adminChamado;
        if (atualizado) {
          alvos.forEach(function (c) {
            Object.keys(atualizado).forEach(function (k) {
              /* `time` no painel do admin é o NOME do time; o payload do
                 competidor não tem esse campo e não pode sobrescrevê-lo. */
              if (atualizado[k] !== undefined) c[k] = atualizado[k];
            });
          });
        }
      }

      fotografar();
      return true;
    },

    /* Métricas do dashboard administrativo */
    metricas: function () {
      var d = carregar();
      var abertos = d.campeonatos.filter(function (c) { return c.status === 'inscricoes'; });
      var soma = function (arr, campo) { return arr.reduce(function (t, c) { return t + (c[campo] || 0); }, 0); };
      return {
        campeonatosAbertos: abertos.length,
        inscritos: soma(d.campeonatos, 'inscritos'),
        oficial: soma(d.campeonatos, 'oficial'),
        espera: soma(d.campeonatos, 'espera'),
        chamadosAbertos: (d.adminChamados || []).filter(function (c) { return c.status !== 'encerrado'; }).length
      };
    },

    /* -------------------------------------------------------------------
       REGISTRO DE AUDITORIA
       Quem fez o quê e quando. Sem isto ninguém sabe quem moveu um time
       para a lista oficial ou quem alterou o campeonato depois da inscrição.

       No modo api quem assina o registro é o servidor, dentro da mesma
       transação da escrita — não existe (nem deve existir) rota para o
       navegador inserir linha de auditoria. O que acontece aqui é só o eco
       local, para a tela que acabou de agir já mostrar a linha; a versão
       oficial chega na próxima rehidratação.
       ------------------------------------------------------------------- */
    registrar: function (area, alvo, acao, detalhe) {
      var d = carregar();
      d.auditoria = d.auditoria || [];

      var sessao = api.sessao();
      var agora = new Date();
      var pad = function (n) { return String(n).padStart(2, '0'); };

      d.auditoria.unshift({
        id: 'log' + agora.getTime() + '-' + Math.floor(d.auditoria.length),
        quando: agora.toISOString(),
        quandoTexto: pad(agora.getDate()) + '/' + pad(agora.getMonth() + 1) + '/' + agora.getFullYear() +
                     ' ' + pad(agora.getHours()) + ':' + pad(agora.getMinutes()),
        quem: sessao ? sessao.nome : 'Sistema',
        papel: sessao ? sessao.papel : 'sistema',
        area: area,
        alvo: alvo || '',
        acao: acao,
        detalhe: detalhe || ''
      });

      /* Mantém o log num tamanho saudável para o localStorage */
      if (d.auditoria.length > 500) d.auditoria.length = 500;

      if (_modo !== 'api') salvar();
    },

    auditoria: function (filtro) {
      var lista = (carregar().auditoria || []).slice();
      if (!filtro) return lista;
      if (filtro.area) lista = lista.filter(function (l) { return l.area === filtro.area; });
      if (filtro.quem) lista = lista.filter(function (l) { return l.quem === filtro.quem; });
      if (filtro.busca) {
        var b = filtro.busca.toLowerCase();
        lista = lista.filter(function (l) {
          return (l.alvo + ' ' + l.acao + ' ' + l.detalhe + ' ' + l.quem).toLowerCase().indexOf(b) !== -1;
        });
      }
      return lista;
    },

    /* -------------------------------------------------------------------
       DUPLICAR CAMPEONATO
       Cada edição repete quase tudo da anterior: regras de elenco, termos,
       premiação e regulamento. Só datas, nome e listas começam do zero.
       ------------------------------------------------------------------- */
    duplicarCampeonato: function (id, ajustes) {
      var origem = api.campeonato(id);
      if (!origem) return { ok: false, erro: 'Campeonato de origem não encontrado.' };

      ajustes = ajustes || {};

      if (_modo === 'api') {
        var r = pedirSync('POST', '/campeonatos/' + encodeURIComponent(id) + '/duplicar', ajustes);
        if (!r.ok) { avisar(r.erro); return { ok: false, erro: r.erro }; }

        var novo = r.dados && r.dados.campeonato;
        if (novo) {
          carregar().campeonatos.push(novo);
          fotografar();
        }
        api.registrar('campeonato', novo ? novo.nome : '', 'duplicou', 'a partir de "' + origem.nome + '"');
        return { ok: true, campeonato: novo };
      }

      var copia = JSON.parse(JSON.stringify(origem));

      copia.id = 'camp-' + Date.now();
      copia.nome = ajustes.nome || (origem.nome + ' (cópia)');
      copia.data = ajustes.data || '';
      copia.dataFim = ajustes.dataFim || '';
      copia.aberturaInscricoes = ajustes.aberturaInscricoes || '';
      copia.encerramentoInscricoes = ajustes.encerramentoInscricoes || '';
      if (ajustes.local) copia.local = ajustes.local;

      /* O que não se herda: listas, resultados e situação da edição anterior */
      copia.status = 'rascunho';
      copia.inscritos = 0;
      copia.oficial = 0;
      copia.espera = 0;
      delete copia.classificacao;
      delete copia.arquivado;
      delete copia.arquivadoEm;

      var d = carregar();
      d.campeonatos.push(copia);
      salvar();

      api.registrar('campeonato', copia.nome, 'duplicou', 'a partir de "' + origem.nome + '"');
      return { ok: true, campeonato: copia };
    },

    /* -------------------------------------------------------------------
       INSCRIÇÃO
       Regra do briefing, sem exceção: toda inscrição nasce na Lista de
       Inscritos (triagem). Só o administrador move para oficial ou espera,
       por isso esta função ignora qualquer status que venha de fora.
       ------------------------------------------------------------------- */
    inscrever: function (campeonatoId, timeId) {
      var d = carregar();
      var camp = api.campeonato(campeonatoId);
      if (!camp) return { ok: false, erro: 'Campeonato não encontrado.' };

      var jaInscrito = (d.minhasInscricoes || []).some(function (i) {
        return i.campeonato === campeonatoId && i.time === timeId && i.status !== 'cancelada';
      });
      if (jaInscrito) return { ok: false, erro: 'Este time já está inscrito neste campeonato.' };

      if (_modo === 'api') {
        var r = pedirSync('POST', '/inscricoes', { campeonatoId: campeonatoId, timeId: timeId });
        if (!r.ok) return { ok: false, erro: r.erro };

        var nova = r.dados.inscricao;
        d.minhasInscricoes = d.minhasInscricoes || [];
        d.minhasInscricoes.push(nova);

        /* Os contadores são derivados das inscrições; a resposta já os traz. */
        if (r.dados.contagens) {
          camp.inscritos = r.dados.contagens.inscritos;
          camp.oficial = r.dados.contagens.oficial;
          camp.espera = r.dados.contagens.espera;
        }

        fotografar();
        return { ok: true, inscricao: nova, protocolo: r.dados.protocolo };
      }

      var protocolo = String(new Date().getFullYear()) + '-' +
                      String(600 + (d.minhasInscricoes || []).length * 7).padStart(6, '0');

      var inscricao = {
        id: 'i' + Date.now(),
        campeonato: campeonatoId,
        time: timeId,
        protocolo: protocolo,
        status: 'triagem',          /* nunca outro valor: a triagem é obrigatória */
        data: new Date().toISOString().slice(0, 10)
      };

      d.minhasInscricoes = d.minhasInscricoes || [];
      d.minhasInscricoes.push(inscricao);
      camp.inscritos = (camp.inscritos || 0) + 1;   /* entra no total, não na lista oficial */
      salvar();

      return { ok: true, inscricao: inscricao, protocolo: protocolo };
    },

    /* Valida um elenco contra as regras da modalidade */
    validarElenco: function (modalidadeId, titulares, reservas) {
      var m = MODALIDADES[modalidadeId] || MODALIDADES.outros;
      var erros = [];
      if (titulares < m.jogadoresMin) {
        erros.push('Cadastre no mínimo ' + m.jogadoresMin + ' jogador(es). Faltam ' + (m.jogadoresMin - titulares) + '.');
      }
      if (titulares > m.jogadoresMax) {
        erros.push('O máximo para ' + m.curto + ' é ' + m.jogadoresMax + ' jogador(es).');
      }
      if (reservas > m.reservasMax) {
        erros.push('O máximo de reservas para ' + m.curto + ' é ' + m.reservasMax + '.');
      }
      return { valido: erros.length === 0, erros: erros };
    }
  };

  /* ---------------------------------------------------------------------
     DISPARO DE E-MAIL A PARTIR DO REGISTRO DA TELA

     admin/email.html grava a LINHA DO HISTÓRICO e considera o e-mail enviado.
     A API precisa do seletor de destinatários, que essa linha não carrega —
     o que ela tem é o rótulo já formatado. Os três rótulos fixos e o nome do
     campeonato são suficientes para reconstruir o alvo.
     --------------------------------------------------------------------- */
  function alvoDoDestino(destino) {
    if (destino === 'Todos os campeonatos') return 'todos';
    if (destino === 'Campeonatos com inscrições abertas') return 'abertos';

    var camp = (_cache.campeonatos || []).filter(function (c) { return c.nome === destino; })[0];
    return camp ? camp.id : null;
  }

  function dispararEmailDoRegistro(item) {
    if (!ehAdmin()) return;

    var alvo = alvoDoDestino(item.destino);
    if (!alvo) {
      /* "Lista manual" não tem equivalente na API: o servidor só conhece os
         responsáveis com inscrição ativa. Fica registrado só no cache. */
      avisar('Envio para lista manual ainda não é aceito pelo servidor. Nada foi disparado.');
      return;
    }

    var r = pedirSync('POST', '/email/disparar', {
      assunto: item.assunto, corpo: item.corpo || '', alvo: alvo
    });

    if (!r.ok) {
      retirar(_cache.emailsEnviados || [], item);
      avisar(r.erro);
      return;
    }

    if (r.dados) {
      item.qtd = r.dados.destinatarios || item.qtd;
      item.destino = r.dados.destino || item.destino;
      item.status = r.dados.status || item.status;
    }
  }

  /* =====================================================================
     PB.api — CAMINHO RECOMENDADO PARA CÓDIGO NOVO

     Mesmo back-end, em fetch, devolvendo Promise. Toda função resolve com
     { ok, status, dados, erro } — nenhuma rejeita, para o chamador tratar erro
     de rede e erro de regra do mesmo jeito.

     Página nova deve usar isto e não PB.dados.*: sem XHR síncrono, sem cache
     global e com os dados sempre frescos.
     ===================================================================== */
  var apiAssincrona = {
    BASE: BASE,

    modo: function () { return _modo; },
    conta: function () { return _conta ? clonar(_conta) : null; },

    pedir: pedir,
    get: function (caminho) { return pedir('GET', caminho); },
    post: function (caminho, corpo) { return pedir('POST', caminho, corpo || {}); },
    put: function (caminho, corpo) { return pedir('PUT', caminho, corpo || {}); },
    patch: function (caminho, corpo) { return pedir('PATCH', caminho, corpo || {}); },
    remover: function (caminho, corpo) { return pedir('DELETE', caminho, corpo || {}); },

    /* ---- Descoberta e sessão ---- */
    ping: function () { return pedir('GET', '/ping'); },
    bootstrap: function () { return pedir('GET', comIdioma('/bootstrap')); },
    entrar: function (email, senha) { return pedir('POST', '/auth/login', { email: email, senha: senha }); },
    sair: function () { return pedir('POST', '/auth/logout', {}); },
    sessao: function () { return pedir('GET', '/auth/sessao'); },
    cadastrar: function (dados) { return pedir('POST', '/auth/cadastro', dados); },
    verificarEmail: function (dados) { return pedir('POST', '/auth/verificar-email', dados); },
    recuperarSenha: function (email) { return pedir('POST', '/auth/recuperar-senha', { email: email }); },
    redefinirSenha: function (dados) { return pedir('POST', '/auth/redefinir-senha', dados); },

    /* ---- Campeonatos ---- */
    campeonatos: function (filtro) {
      var q = [];
      if (filtro && filtro.status) q.push('status=' + encodeURIComponent(filtro.status));
      if (filtro && filtro.modalidade) q.push('modalidade=' + encodeURIComponent(filtro.modalidade));
      return pedir('GET', '/campeonatos' + (q.length ? '?' + q.join('&') : ''));
    },
    campeonato: function (id) { return pedir('GET', '/campeonatos/' + encodeURIComponent(id)); },
    inscricoesAbertas: function () { return pedir('GET', '/campeonatos/abertas'); },
    inscritosDoCampeonato: function (id) { return pedir('GET', '/campeonatos/' + encodeURIComponent(id) + '/inscritos'); },
    salvarCampeonato: function (camp) {
      return camp && camp.id
        ? pedir('PUT', '/campeonatos/' + encodeURIComponent(camp.id), camp)
        : pedir('POST', '/campeonatos', camp);
    },
    mudarStatusCampeonato: function (id, status) {
      return pedir('POST', '/campeonatos/' + encodeURIComponent(id) + '/status', { status: status });
    },
    apurarCampeonato: function (id, classificacao) {
      return pedir('POST', '/campeonatos/' + encodeURIComponent(id) + '/apuracao', { classificacao: classificacao });
    },
    duplicarCampeonato: function (id, ajustes) {
      return pedir('POST', '/campeonatos/' + encodeURIComponent(id) + '/duplicar', ajustes || {});
    },

    /* ---- Times e elenco ---- */
    times: function () { return pedir('GET', '/times'); },
    time: function (id) { return pedir('GET', '/times/' + encodeURIComponent(id)); },
    salvarTime: function (time) {
      return time && time.id
        ? pedir('PUT', '/times/' + encodeURIComponent(time.id), time)
        : pedir('POST', '/times', time);
    },
    excluirTime: function (id) { return pedir('DELETE', '/times/' + encodeURIComponent(id), {}); },
    elenco: function (id) { return pedir('GET', '/times/' + encodeURIComponent(id) + '/elenco'); },
    salvarJogador: function (timeId, jogador) {
      return jogador && jogador.id
        ? pedir('PUT', '/times/' + encodeURIComponent(timeId) + '/jogadores/' + encodeURIComponent(jogador.id), jogador)
        : pedir('POST', '/times/' + encodeURIComponent(timeId) + '/jogadores', jogador);
    },
    excluirJogador: function (timeId, jogadorId) {
      return pedir('DELETE', '/times/' + encodeURIComponent(timeId) + '/jogadores/' + encodeURIComponent(jogadorId), {});
    },
    salvarStaff: function (timeId, membro) {
      return membro && membro.id
        ? pedir('PUT', '/times/' + encodeURIComponent(timeId) + '/staff/' + encodeURIComponent(membro.id), membro)
        : pedir('POST', '/times/' + encodeURIComponent(timeId) + '/staff', membro);
    },
    excluirStaff: function (timeId, staffId) {
      return pedir('DELETE', '/times/' + encodeURIComponent(timeId) + '/staff/' + encodeURIComponent(staffId), {});
    },

    /* ---- Documentos ---- */
    documentacao: function (timeId) { return pedir('GET', '/times/' + encodeURIComponent(timeId) + '/documentacao'); },
    enviarDocumento: function (timeId, jogadorId, tipo, dados) {
      return pedir('PUT',
        '/times/' + encodeURIComponent(timeId) +
        '/jogadores/' + encodeURIComponent(jogadorId) +
        '/documentos/' + encodeURIComponent(tipo), dados);
    },
    conferirDocumento: function (documentoId, status, observacao) {
      return pedir('POST', '/documentos/' + encodeURIComponent(documentoId) + '/conferir',
                   { status: status, observacao: observacao || '' });
    },

    /* ---- Inscrições ---- */
    inscricoes: function () { return pedir('GET', '/inscricoes'); },
    inscrever: function (campeonatoId, timeId) {
      return pedir('POST', '/inscricoes', { campeonatoId: campeonatoId, timeId: timeId });
    },
    mudarStatusInscricao: function (id, status, observacao) {
      return pedir('POST', '/inscricoes/' + encodeURIComponent(id) + '/status',
                   { status: status, observacao: observacao || '' });
    },
    cancelarInscricao: function (id, motivo) {
      return pedir('DELETE', '/inscricoes/' + encodeURIComponent(id), { observacao: motivo || '' });
    },

    /* ---- Chamados ---- */
    chamados: function () { return pedir('GET', '/chamados'); },
    chamado: function (protocolo) { return pedir('GET', '/chamados/' + encodeURIComponent(protocolo)); },
    abrirChamado: function (dados) { return pedir('POST', '/chamados', dados); },
    responderChamado: function (protocolo, texto) {
      return pedir('POST', '/chamados/' + encodeURIComponent(protocolo) + '/mensagens', { texto: texto });
    },
    mudarStatusChamado: function (protocolo, status) {
      return pedir('POST', '/chamados/' + encodeURIComponent(protocolo) + '/status', { status: status });
    },

    /* ---- Conteúdo ---- */
    posts: function () { return pedir('GET', '/posts'); },
    post: function (id) { return pedir('GET', '/posts/' + encodeURIComponent(id)); },
    categorias: function () { return pedir('GET', '/categorias'); },
    eventos: function () { return pedir('GET', '/eventos'); },
    parceiros: function () { return pedir('GET', '/parceiros'); },
    banners: function () { return pedir('GET', '/banners'); },
    bannersSite: function () { return pedir('GET', '/banners-site'); },
    ordenarBannerSite: function (id, ordem) {
      return pedir('POST', '/banners-site/' + encodeURIComponent(id) + '/ordem', { ordem: ordem });
    },

    /* ---- Administração ---- */
    metricas: function () { return pedir('GET', '/admin/metricas'); },
    usuarios: function () { return pedir('GET', '/admin/usuarios'); },
    salvarUsuario: function (u) {
      return u && u.id
        ? pedir('PUT', '/admin/usuarios/' + encodeURIComponent(u.id), u)
        : pedir('POST', '/admin/usuarios', u);
    },
    ranking: function (modalidade) { return pedir('GET', '/ranking/' + encodeURIComponent(modalidade)); },
    salvarRanking: function (modalidade, linhas) {
      return pedir('PUT', '/ranking/' + encodeURIComponent(modalidade), { linhas: linhas });
    },
    rankingConfig: function (modalidade) { return pedir('GET', '/ranking-config/' + encodeURIComponent(modalidade)); },
    salvarRankingConfig: function (modalidade, cfg) {
      return pedir('PUT', '/ranking-config/' + encodeURIComponent(modalidade), cfg);
    },
    auditoria: function (filtro) {
      var q = [];
      if (filtro && filtro.area) q.push('area=' + encodeURIComponent(filtro.area));
      if (filtro && filtro.de) q.push('de=' + encodeURIComponent(filtro.de));
      if (filtro && filtro.ate) q.push('ate=' + encodeURIComponent(filtro.ate));
      return pedir('GET', '/auditoria' + (q.length ? '?' + q.join('&') : ''));
    },
    historico: function (tabela) {
      return pedir('GET', '/historico' + (tabela ? '?tabela=' + encodeURIComponent(tabela) : ''));
    },
    restaurarDoHistorico: function (tabela, id) {
      return pedir('POST', '/historico/restaurar', { tabela: tabela, id: id });
    },
    excluirDoHistorico: function (tabela, id) {
      return pedir('DELETE', '/historico', { tabela: tabela, id: id });
    },

    /* ---- E-mail ---- */
    modelosEmail: function () { return pedir('GET', '/email/modelos'); },
    salvarModeloEmail: function (id, dados) { return pedir('PUT', '/email/modelos/' + encodeURIComponent(id), dados); },
    variaveisEmail: function () { return pedir('GET', '/email/variaveis'); },
    smtp: function () { return pedir('GET', '/email/smtp'); },
    salvarSmtp: function (cfg) { return pedir('PUT', '/email/smtp', cfg); },
    testarSmtp: function (para) { return pedir('POST', '/email/testar', { para: para }); },
    emailsEnviados: function () { return pedir('GET', '/email/enviados'); },
    previaEmail: function (dados) { return pedir('POST', '/email/previa', dados); },
    dispararEmail: function (dados) { return pedir('POST', '/email/disparar', dados); }
  };

  /* =====================================================================
     ARRANQUE

     Roda no parse do arquivo, antes de qualquer script de página. Em modo
     local nada acontece: o cache continua preguiçoso, montado no primeiro
     carregar(), exatamente como antes.
     ===================================================================== */
  function iniciar() {
    if (!descobrir()) { _modo = 'local'; return; }

    _modo = 'api';
    if (!hidratar()) {
      /* Respondeu ao ping mas não entregou o bootstrap: sem dados confiáveis,
         é mais honesto cair para a demonstração do que abrir a tela vazia. */
      _modo = 'local';
      _cache = null;
      return;
    }

    /* Nenhum e-mail nem senha vive neste arquivo quando há servidor. */
    CONTAS = [];
    api.CONTAS = CONTAS;
  }

  iniciar();

  global.PB = global.PB || {};
  global.PB.dados = api;
  global.PB.api = apiAssincrona;
})(window);
