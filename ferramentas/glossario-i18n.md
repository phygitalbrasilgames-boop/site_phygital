# Glossário de tradução — Phygital Brasil

Vocabulário obrigatório para **inglês** e **espanhol**. Existe porque as ~3.600
strings da interface são traduzidas por várias mãos: sem uma lista fechada, o
mesmo "chamado" vira *ticket* numa tela e *request* na seguinte, e o usuário
deixa de reconhecer que é a mesma coisa.

Quem traduzir uma string que contenha um termo desta tabela **usa a forma daqui**,
mesmo que exista sinônimo melhor isolado. Consistência vence elegância.

## Marca — nunca traduzir

| pt-BR | en | es |
|---|---|---|
| Phygital | Phygital | Phygital |
| Phygital Brasil | Phygital Brasil | Phygital Brasil |
| Esportes Phygital | Phygital Sports | Deportes Phygital |
| Games of the Future | Games of the Future | Games of the Future |

`Phygital` é marca registrada e nome da modalidade: fica igual nos três idiomas,
inclusive em "Phygital Futebol" → "Phygital Football" / "Phygital Fútbol".

## Competição

| pt-BR | en | es |
|---|---|---|
| Campeonato | Championship | Campeonato |
| Etapa | Stage | Etapa |
| Modalidade | Sport | Modalidad |
| Futebol | Football | Fútbol |
| Basquete | Basketball | Baloncesto |
| Dance | Dance | Dance |
| Shooter | Shooter | Shooter |
| Vagas | Slots | Plazas |
| Ranking | Ranking | Clasificación |
| Apuração | Final standings | Resultados finales |
| Classificação | Standings | Clasificación |
| Título | Title | Título |
| Confronto | Match | Enfrentamiento |
| Placar | Score | Marcador |

"Sport" e não "Modality": *modality* existe em inglês, mas soa a jargão médico.

## Time e elenco

| pt-BR | en | es |
|---|---|---|
| Time | Team | Equipo |
| Elenco | Roster | Plantilla |
| Titular | Starter | Titular |
| Reserva | Substitute | Suplente |
| Comissão técnica | Coaching staff | Cuerpo técnico |
| Treinador | Coach | Entrenador |
| Atleta | Athlete | Atleta |
| Jogador | Player | Jugador |
| Escudo | Crest | Escudo |
| Responsável | Team manager | Responsable |
| Categoria | Age group | Categoría |
| Número da camisa | Shirt number | Dorsal |

"Responsável" é quem responde pelo time no sistema — *team manager*, não
*responsible* (que em inglês é adjetivo, não cargo).

## Inscrição

| pt-BR | en | es |
|---|---|---|
| Inscrição | Registration | Inscripción |
| Inscrições abertas | Registration open | Inscripciones abiertas |
| Inscrever time | Register team | Inscribir equipo |
| Encerramento das inscrições | Registration deadline | Cierre de inscripciones |
| Lista de Inscritos | Applicants list | Lista de solicitantes |
| Em triagem | Under review | En revisión |
| Lista Oficial | Official list | Lista oficial |
| Lista de Espera | Waiting list | Lista de espera |
| Protocolo | Reference number | Número de referencia |
| Cancelada | Cancelled | Cancelada |

A distinção entre "Lista de Inscritos" e "Lista Oficial" é regra do regulamento:
estar inscrito **não** garante vaga. A tradução tem que preservar essa diferença —
por isso *applicants* e não *registered*.

## Atendimento

| pt-BR | en | es |
|---|---|---|
| Chamado | Support ticket | Ticket de soporte |
| Abrir chamado | Open a ticket | Abrir un ticket |
| Aberto | Open | Abierto |
| Em andamento | In progress | En curso |
| Respondido | Answered | Respondido |
| Encerrado | Closed | Cerrado |
| Organização | Organisers | Organización |

## Painéis e conta

| pt-BR | en | es |
|---|---|---|
| Painel do Competidor | Competitor Panel | Panel del Competidor |
| Painel do Administrador | Admin Panel | Panel de Administrador |
| Acessar Painel | Sign in | Acceder al panel |
| Entrar | Sign in | Iniciar sesión |
| Sair da conta | Sign out | Cerrar sesión |
| Conta | Account | Cuenta |
| Cadastro | Sign up | Registro |
| Senha | Password | Contraseña |
| Primeiro acesso | First sign-in | Primer acceso |
| Código de verificação | Verification code | Código de verificación |
| Nível de acesso | Access level | Nivel de acceso |
| Master | Master | Master |
| Gestor de Campeonato | Championship Manager | Gestor de Campeonato |
| Operação | Operations | Operaciones |

`Cadastro` é *sign up* quando é a ação de criar conta, e *registration details*
quando é o conjunto de dados da pessoa. Olhe o contexto no `pt.json`.

## Conteúdo e administração

| pt-BR | en | es |
|---|---|---|
| Banner | Banner | Banner |
| Publicação | Post | Publicación |
| Blog | Blog | Blog |
| Categoria | Category | Categoría |
| Disparo de e-mail | Email campaign | Envío de correos |
| Modelo de e-mail | Email template | Plantilla de correo |
| Registro de Atividade | Activity log | Registro de actividad |
| Histórico | Archive | Archivo |
| Arquivar | Archive | Archivar |
| Restaurar | Restore | Restaurar |
| Excluir definitivamente | Delete permanently | Eliminar definitivamente |
| Exportar informações | Export data | Exportar datos |
| Parceiros | Partners | Socios |
| Documento | Document | Documento |

## Regras de estilo

**Tom.** Português usa "você" e o site fala direto com a pessoa. Mantenha em
inglês (*you*) e em espanhol use **tú**, não *usted* — o público é de atleta
jovem, e *usted* soa institucional demais para a marca.

**Botões.** Verbo no infinitivo em inglês (*Register team*, *Open a ticket*) e em
espanhol (*Inscribir equipo*). Nunca gerúndio.

**Maiúsculas.** Português capitaliza só a primeira palavra em títulos; inglês
também — *sentence case*, não *Title Case*. Não force capitalização inglesa em
tudo, o design já usa `text-transform: uppercase` onde precisa.

**Marcadores `{0}`, `{1}`.** São valores injetados em tempo de execução. Preserve
todos, sem alterar o número. A ORDEM pode mudar se a língua pedir — a
substituição é por número, não por posição. Marcador a mais ou a menos quebra a
frase na tela.

**Comprimento.** Inglês costuma encolher e espanhol crescer ~20% sobre o
português. Em rótulo de botão e item de menu, prefira a forma curta: o layout é
fixo e não pode ser alterado.

**Acentuação e pontuação.** Espanhol leva `¿` e `¡` de abertura. O travessão `—`
usado no português pode virar vírgula ou dois-pontos quando ficar estranho.

**O que NÃO traduzir.** Nome de campeonato, de time, de atleta e de parceiro são
dado cadastrado e não estão neste dicionário. Se aparecer algum, é engano de
extração — relate em vez de traduzir.
