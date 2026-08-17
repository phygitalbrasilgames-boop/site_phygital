#!/bin/bash
# =============================================================================
#  PHYGITAL BRASIL — servidor local
#  Dê dois cliques neste arquivo para abrir o site no navegador.
#  Para parar o servidor: feche esta janela do Terminal ou pressione Ctrl+C.
# =============================================================================

cd "$(dirname "$0")" || exit 1

PORTA=8080

# Se a porta estiver ocupada, procura a próxima livre (até 8090)
while lsof -i :$PORTA >/dev/null 2>&1; do
  echo "Porta $PORTA ocupada, tentando a próxima..."
  PORTA=$((PORTA + 1))
  if [ $PORTA -gt 8090 ]; then
    echo "Nenhuma porta livre entre 8080 e 8090. Feche outros servidores e tente de novo."
    read -r -p "Pressione Enter para sair."
    exit 1
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 não encontrado."
  echo "Instale com:  xcode-select --install"
  read -r -p "Pressione Enter para sair."
  exit 1
fi

URL="http://localhost:$PORTA"

echo ""
echo "  ██  PHYGITAL BRASIL — SERVIDOR LOCAL"
echo "  ────────────────────────────────────────────────"
echo "  Site:              $URL"
echo "  Painel Competidor: $URL/painel/"
echo "  Painel Admin:      $URL/admin/"
echo "  ────────────────────────────────────────────────"
echo "  Para parar: Ctrl+C ou feche esta janela."
echo ""

python3 servidor.py "$PORTA"
