# Novo site — Phygital Brasil

Protótipo navegável do novo site, construído a partir do documento **NOVO SITE PHYGITAL BRASIL.pdf**
e da identidade visual do **Branding Book Phygital Brasil (Edição 01 · 2026)**.

É HTML, CSS e JavaScript puros: **não precisa instalar nada, não tem etapa de build**. Abra e use.

---

## Como testar no seu Mac

### Opção 1 — dois cliques (mais simples)

Dê dois cliques em **`ABRIR SITE.command`**.

Ele sobe um servidor local, abre o navegador sozinho e mostra os três endereços:

| O quê | Endereço |
|---|---|
| Site público | `http://localhost:8080` |
| Painel do Competidor | `http://localhost:8080/painel/` |
| Painel do Administrador | `http://localhost:8080/admin/` |

Para parar: pressione `Ctrl+C` na janela do Terminal, ou simplesmente feche a janela.

> Na primeira vez o macOS pode perguntar se você confia no arquivo. Se ele não abrir,
> clique com o botão direito → **Abrir** → **Abrir** de novo. Se ainda assim não rodar,
> use a Opção 2.

### Opção 2 — pelo Terminal

```bash
cd "/Users/samuel/Documents/01 - MEUS PROJETOS/Site_Phygital" && python3 -m http.server 8080 --directory site
```

Depois abra `http://localhost:8080` no navegador.

### Por que precisa de servidor?

As páginas carregam dados por JavaScript. Abrindo os arquivos direto com dois cliques
(`file://`) o navegador bloqueia parte disso e algumas listas aparecem vazias.
Com o servidor local tudo funciona igual ao site publicado.

---

## O que já dá para testar

**Site público**
- Home com hero rotativo, números, inscrições abertas, modalidades, notícias, ranking nacional por
  modalidade, galeria de eventos e parceiros
- Quem Somos, Modalidades (as 5 páginas), Inscrições, Eventos, Parceiros, Blog, Post e Contato
- A seção de inscrições abertas **some sozinha** quando não há nenhum campeonato aberto —
  conforme pedido no briefing

**Painel do Competidor** (`/painel/`)
- Tela de carregamento com o logo → login → cadastro → confirmação de e-mail por código
- Início com banner rotativo, pendências e atalhos
- Meus Times, cadastro de time em 3 etapas **com formulário diferente por modalidade**
- Inscrições (com o bloqueio de edição após o encerramento), Ranking, Chamados e Conta

**Painel do Administrador** (`/admin/`)
- Dashboard com os números do briefing
- Banners, Campeonatos (criar, gerenciar, listas de triagem/oficial/espera, apuração)
- Chamados, Blog, Disparo de e-mail com pré-visualização e configuração de SMTP, Usuários

> No protótipo, o login aceita qualquer e-mail e senha. Na tela de login há dois botões de atalho
> para entrar direto como competidor ou como administrador.

---

## Regras do briefing que estão implementadas

| Regra | Onde ver |
|---|---|
| Elenco por modalidade (futebol 6–8, basquete 3–4, shooter 5, dance 1) | `painel/time-cadastro.html` |
| Reservas e comissão técnica diferentes por modalidade | `painel/time-cadastro.html` |
| Steam64 e Faceit obrigatórios no Shooter | `painel/time-cadastro.html?mod=shooter` |
| Categoria (Sub 16/17/18, Amador, Profissional) só no Futebol | `painel/time-cadastro.html?mod=futebol` |
| Inscrito entra em triagem → admin move para oficial ou espera | `admin/campeonato-gerenciar.html` |
| Protocolo por e-mail, deixando claro que não garante vaga | `inscricoes.html` e `painel/inscricoes.html` |
| Alteração livre só até o encerramento; depois, só por chamado | `painel/inscricoes.html` |
| Apuração manual da classificação alimenta o ranking | `admin/campeonato-apuracao.html` |
| Exportação .zip com pasta por time + .xlsx (e a exceção da Dança) | `admin/campeonato-gerenciar.html` |
| Troca de e-mail envia o código para o endereço **antigo** | `painel/conta.html` |
| SMTP único para todos os e-mails do sistema | `admin/email.html` |
| Níveis de acesso (Master, Gestor de Campeonato, Operação) | `admin/usuarios.html` |

---

## Estrutura dos arquivos

```
site/
├── index.html                  Home
├── quem-somos.html  modalidades.html  mod-*.html
├── inscricoes.html  eventos.html  parceiros.html  contato.html
├── blog.html  post.html
├── painel/                     Painel do Competidor
├── admin/                      Painel do Administrador
└── assets/
    ├── css/
    │   ├── phygital.css        Design system (cores, tipografia, componentes)
    │   ├── site.css            Site público
    │   └── painel.css          Painéis
    ├── js/
    │   ├── dados.js            Dados de demonstração + regras por modalidade
    │   └── phygital.js         Comportamentos de interface
    └── img/
        ├── logo/               Logos oficiais (do /ID)
        └── mock/               Imagens de demonstração
```

### Onde mexer no visual

Tudo que é cor, fonte, espaçamento e forma está no topo de **`site/assets/css/phygital.css`**,
no bloco `:root`. Mudar uma variável ali muda o site inteiro.

### Onde mexer nos dados de demonstração

**`site/assets/js/dados.js`** — campeonatos, ranking, posts, times, chamados, usuários.
As regras de cada modalidade estão em `MODALIDADES`, no início do arquivo: é a fonte única
de verdade usada por todos os formulários e validações.

> Os dados ficam salvos no navegador (localStorage). Para voltar tudo ao estado original,
> abra o console do navegador e rode `PB.dados.resetar()`.

---

## Identidade visual aplicada

Direto do Branding Book:

- **Cores** — Verde Phygital `#009B4A`, Verde Mata `#004A1B`, Amarelo Ouro `#FCE001`,
  Âmbar `#DF9911`, Azul Atlântico `#0A66B1`, azul claro `#3D93D6`.
  Neutros `#0E1113`, `#6E7377`, `#F5F6F4`. Proporção 60% neutro · 30% verde · 10% amarelo e azul.
- **Tipografia** — **Saira** em títulos, números e placar (Bold, tracking −2%);
  **Barlow** em texto e interface (entrelinha 1,6). Alternativas de sistema: Arial Narrow e Helvetica.
- **Logo** — a versão colorida tem lettering branco e é usada **somente sobre fundo escuro**;
  sobre fundo claro entra a versão preta. Área de proteção e tamanhos mínimos respeitados.
- **Elemento de assinatura** — a **fita**. As três fitas que constroem o "P" do símbolo aparecem
  como a barra tricolor no topo dos cards, no marcador dos títulos de seção, no item de menu ativo
  e nas diagonais do hero. É o que dá ao site uma cara própria em vez de template genérico.

A referência de layout foi `https://tornados.ancorathemes.com/` — hero, inscrições abertas,
notícias e tabela de ranking seguem aquela ordem, mas com a linguagem visual da Phygital Brasil
(o tema original é vermelho e preto; aqui é preto e branco com a cor entrando pontualmente).

---

## O que este protótipo **não** faz

É a camada visual e de navegação. Ainda **não existe back-end**, e portanto:

- login não autentica de verdade (qualquer e-mail entra)
- nada é gravado em banco de dados — só no navegador
- nenhum e-mail é realmente enviado
- a exportação `.zip` / `.xlsx` mostra a tela e explica o formato, mas não gera o arquivo
- upload de foto/logo mostra a pré-visualização, mas não envia para lugar nenhum

Esses pontos são o próximo passo do projeto. As telas, os campos, as regras de elenco e os fluxos
já estão definidos aqui — o back-end pode ser construído em cima deste contrato.
