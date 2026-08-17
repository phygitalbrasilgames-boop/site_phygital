#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor local do site Phygital Brasil.

Igual ao `python3 -m http.server`, com uma diferença importante: envia
Cache-Control: no-store em tudo. Sem isso o navegador guarda o CSS e o
JavaScript antigos e as alterações não aparecem sem limpar o cache na mão.

Uso:  python3 servidor.py [porta]
"""

import functools
import http.server
import os
import socketserver
import sys
import webbrowser

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")


class SemCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, formato, *args):
        # Só registra erros: o log de cada arquivo servido polui o terminal.
        codigo = str(args[1]) if len(args) > 1 else ""
        if codigo.startswith(("4", "5")):
            super().log_message(formato, *args)


def porta_livre(inicial=8080, tentativas=12):
    for p in range(inicial, inicial + tentativas):
        try:
            with socketserver.TCPServer(("", p), None):
                return p
        except OSError:
            continue
    return None


def main():
    if not os.path.isdir(RAIZ):
        print("Pasta 'site' não encontrada em", RAIZ)
        return 1

    pedida = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8080
    porta = porta_livre(pedida)
    if porta is None:
        print("Nenhuma porta livre a partir de", pedida)
        return 1

    url = "http://localhost:%d" % porta
    handler = functools.partial(SemCache, directory=RAIZ)

    print("")
    print("  ██  PHYGITAL BRASIL — SERVIDOR LOCAL")
    print("  " + "─" * 48)
    print("  Site:              %s" % url)
    print("  Painel Competidor: %s/painel/" % url)
    print("  Painel Admin:      %s/admin/" % url)
    print("  " + "─" * 48)
    print("  Cache desativado: basta recarregar a página (Cmd+R)")
    print("  Para parar: Ctrl+C")
    print("")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", porta), handler) as servidor:
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor encerrado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
