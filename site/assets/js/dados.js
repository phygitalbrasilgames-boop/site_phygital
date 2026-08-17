/* ==========================================================================
   PHYGITAL BRASIL — CAMADA DE DADOS (protótipo)
   Dados de demonstração + persistência em localStorage.
   Quando o back-end existir, troque as funções de PB.api por chamadas HTTP:
   a assinatura de cada função foi desenhada para ser um contrato estável.
   ========================================================================== */
(function (global) {
  'use strict';

  var CHAVE = 'phygital.dados.v2';
  var CHAVE_SESSAO = 'phygital.sessao.v1';

  /* ---------------------------------------------------------------------
     CONTAS DE ACESSO (protótipo)
     Quando o back-end existir estas credenciais saem daqui: a autenticação
     passa a ser feita no servidor e o cliente guarda apenas o token.
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
     SEMENTE DE DEMONSTRAÇÃO
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

      smtp: {
        email: 'inscricoes@phygitalgamesbr.com.br',
        senha: 'Phygital@2026',
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

  /* ---------------------------------------------------------------------
     PERSISTÊNCIA
     --------------------------------------------------------------------- */
  var _cache = null;

  function carregar() {
    if (_cache) return _cache;
    try {
      var bruto = global.localStorage && localStorage.getItem(CHAVE);
      _cache = bruto ? JSON.parse(bruto) : semente();
    } catch (e) {
      _cache = semente();
    }
    return _cache;
  }

  function salvar() {
    try {
      if (global.localStorage) localStorage.setItem(CHAVE, JSON.stringify(_cache));
    } catch (e) { /* modo privado / cota — segue em memória */ }
  }

  function resetar() {
    _cache = semente();
    salvar();
    return _cache;
  }

  /* ---------------------------------------------------------------------
     CONSULTAS
     --------------------------------------------------------------------- */
  var api = {
    MODALIDADES: MODALIDADES,
    STATUS_INSCRICAO: STATUS_INSCRICAO,
    STATUS_CHAMADO: STATUS_CHAMADO,
    STATUS_CAMPEONATO: STATUS_CAMPEONATO,
    TIPOS_DOCUMENTO: TIPOS_DOCUMENTO,
    STATUS_DOCUMENTO: STATUS_DOCUMENTO,
    CONTAS: CONTAS,

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

    /* Registra ou atualiza um documento do jogador */
    gravarDocumento: function (timeId, indiceJogador, doc) {
      var d = carregar();
      var time = (d.meusTimes || []).filter(function (t) { return t.id === timeId; })[0];
      if (!time) return false;
      var j = (time.jogadores || [])[indiceJogador];
      if (!j) return false;

      j.documentos = j.documentos || [];
      var atual = j.documentos.filter(function (x) { return x.tipo === doc.tipo; })[0];
      if (atual) {
        Object.keys(doc).forEach(function (k) { atual[k] = doc[k]; });
      } else {
        j.documentos.push(doc);
      }
      salvar();
      api.registrar('documento', time.nome,
        doc.status === 'aprovado' ? 'aprovou' : doc.status === 'recusado' ? 'recusou' : 'enviou',
        j.nome + ' · ' + (TIPOS_DOCUMENTO[doc.tipo] || {}).nome);
      return true;
    },

    tudo: carregar,
    salvar: salvar,
    resetar: resetar,

    /* -------------------------------------------------------------------
       AUTENTICAÇÃO (protótipo — a validação real será do servidor)
       ------------------------------------------------------------------- */
    autenticar: function (email, senha) {
      var e = String(email || '').trim().toLowerCase();
      var conta = CONTAS.filter(function (c) { return c.email.toLowerCase() === e; })[0];
      if (!conta) return { ok: false, erro: 'E-mail não encontrado.' };
      if (conta.senha !== senha) return { ok: false, erro: 'Senha incorreta.' };
      return { ok: true, conta: conta };
    },

    abrirSessao: function (conta) {
      try {
        global.localStorage.setItem(CHAVE_SESSAO, JSON.stringify({
          email: conta.email, papel: conta.papel, nome: conta.nome, nivel: conta.nivel
        }));
      } catch (e) { /* modo privado */ }
    },

    sessao: function () {
      try {
        var b = global.localStorage.getItem(CHAVE_SESSAO);
        return b ? JSON.parse(b) : null;
      } catch (e) { return null; }
    },

    encerrarSessao: function () {
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
      if (i >= 0) {
        /* merge: preserva campos que a tela de edição não envia */
        Object.keys(item).forEach(function (k) { d[colecao][i][k] = item[k]; });
      } else {
        d[colecao].push(item);
      }
      salvar();
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
      item.arquivado = true;
      item.arquivadoEm = new Date().toISOString().slice(0, 16).replace('T', ' ');
      if (motivo) item.arquivadoMotivo = motivo;
      salvar();
      return true;
    },

    restaurar: function (colecao, valor, chave) {
      chave = chave || 'id';
      var d = carregar();
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
      if (!d[colecao]) return false;
      var i = d[colecao].map(function (x) { return x[chave]; }).indexOf(valor);
      if (i < 0) return false;
      d[colecao].splice(i, 1);
      salvar();
      return true;
    },

    /* Itens no histórico de uma coleção */
    arquivados: function (colecao) {
      return (carregar()[colecao] || []).filter(function (x) { return x.arquivado; });
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
      d[caminho] = valor;
      salvar();
      return valor;
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
    usuario: function () { return carregar().usuario; },
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

      salvar();
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
        chamadosAbertos: d.adminChamados.filter(function (c) { return c.status !== 'encerrado'; }).length
      };
    },

    /* -------------------------------------------------------------------
       REGISTRO DE AUDITORIA
       Quem fez o quê e quando. Sem isto ninguém sabe quem moveu um time
       para a lista oficial ou quem alterou o campeonato depois da inscrição.
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
      salvar();
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

      var copia = JSON.parse(JSON.stringify(origem));
      ajustes = ajustes || {};

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

  global.PB = global.PB || {};
  global.PB.dados = api;
})(window);
