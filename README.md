# Quiniela de hoy

Una mini-app sin publicidad diseñada para instalar como acceso directo en Android. Muestra los cinco turnos de Quiniela de la Ciudad para hoy y ayer.

## Publicación gratuita

1. Crear un repositorio **público** gratis en GitHub y subir esta carpeta completa.
2. En **Settings → Pages**, elegir **Deploy from a branch**, rama `main` y carpeta `/(root)`.
3. La página se publica con una dirección `https://USUARIO.github.io/NOMBRE-DEL-REPOSITORIO/`.
4. En el teléfono, abrir esa dirección con Chrome, tocar el menú `⋮` y elegir **Agregar a la pantalla principal**.

## Actualización automática

La carpeta ya incluye una tarea de GitHub Actions que consulta la fuente oficial cada 15 minutos, actualiza `data/results.json` y guarda ese cambio en el repositorio. La app instalada en el teléfono consulta ese archivo cada cinco minutos. No guarda apuestas ni pide datos personales.

En GitHub, entrar en la pestaña **Actions** y habilitar los flujos de trabajo si GitHub lo solicita. La primera vez, abrir **Actualizar resultados → Run workflow** para llenar la pantalla sin esperar al próximo turno automático. GitHub puede demorar alguna ejecución programada; el botón **ACTUALIZAR AHORA** del teléfono vuelve a consultar el último resultado publicado.

Fuente prevista: https://quiniela.loteriadelaciudad.gob.ar/
