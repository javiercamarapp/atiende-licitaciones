#!/usr/bin/env bash
# Reescribe la autoría (autor y committer) de TODO el historial de main al nombre y correo
# verificados en GitHub, sin tocar el contenido de ningún commit ni el árbol de trabajo,
# y sube el resultado con force-push al repositorio privado recién creado.
# Uso: bash scripts/reescribir-autoria.sh
set -euo pipefail
NOMBRE="Javier Cámara Porte Petit"
CORREO="javiercamaraportepetit@gmail.com"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
OLD="$(git rev-parse main)"
W="$(mktemp -d)/rewrite-autoria"
git clone -q --no-local --branch main --single-branch . "$W"
cd "$W"
export FILTER_BRANCH_SQUELCH_WARNING=1
git filter-branch -f --env-filter "export GIT_AUTHOR_NAME='$NOMBRE'; export GIT_AUTHOR_EMAIL='$CORREO'; export GIT_COMMITTER_NAME='$NOMBRE'; export GIT_COMMITTER_EMAIL='$CORREO'" -- --all >/dev/null 2>&1
echo "Autoría tras reescritura:"; git log --format='%an <%ae>' | sort | uniq -c
cd "$REPO"
git fetch -q "$W" main:refs/rewritten/main
[ "$(git rev-parse "$OLD^{tree}")" = "$(git rev-parse 'refs/rewritten/main^{tree}')" ] && echo "Árbol idéntico: OK (no cambia ningún archivo)"
if git update-ref refs/heads/main refs/rewritten/main "$OLD"; then
  echo "main actualizado (compare-and-swap)."
else
  echo "HEAD avanzó durante la reescritura; vuelve a ejecutar el script." >&2; exit 1
fi
git config user.name "$NOMBRE"; git config user.email "$CORREO"
git push --force origin main
echo "Listo: $(git rev-list --count main) commits en GitHub a nombre de $NOMBRE <$CORREO>."
rm -rf "$W"
