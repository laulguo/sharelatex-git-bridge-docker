FROM sharelatex/sharelatex:3.4.0

# The 3.4.0 base image ships an incomplete TeX Live 2022: the XeTeX engine is
# absent entirely and several common packages are missing, so any project with
# compiler=xelatex fails with "no output.pdf generated". Restore the engine from
# a frozen TeX Live 2022 repository and add the packages this deployment needs.
# Override the mirror at build time when yours is closer or the default is
# unreachable:  docker build --build-arg TL2022_REPO=... -t ... git-ui
# Keep this layer before the COPY lines so editing UI files never re-downloads it.
ARG TL2022_REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final
RUN tlmgr --verify-repo=none install \
        --repository "$TL2022_REPO" \
        xetex xetexconfig wrapfig float placeins \
 && for b in xelatex xetex; do \
        [ -e "/usr/local/bin/$b" ] || ln -s "/usr/local/texlive/2022/bin/x86_64-linux/$b" "/usr/local/bin/$b"; \
    done \
 && fmtutil-sys --byfmt xelatex \
 && xelatex --version | head -1

COPY editor.pug /overleaf/services/web/app/views/project/editor.pug
COPY git-bridge-toolbar.js /overleaf/services/web/public/js/git-bridge-toolbar.js
COPY git-bridge-toolbar.css /overleaf/services/web/public/css/git-bridge-toolbar.css
COPY sharelatex.conf /etc/nginx/sites-enabled/sharelatex.conf
# Let the snapshot adapter evict documents through the service's own API. Only
# this one process binds to 0.0.0.0; port 3003 stays unpublished.
COPY --chmod=755 document-updater-run /etc/service/document-updater-sharelatex/run
