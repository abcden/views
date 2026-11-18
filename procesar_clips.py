#!/usr/bin/env python3
"""Genera hasta cinco clips MP4 de un video público autorizado.

No requiere claves, APIs privadas ni servicios de pago. Los puntajes provienen
de cambios de escena y aumentos de volumen; no son una comprensión semántica.
"""

import argparse
import array
import json
import ipaddress
import math
import os
from pathlib import Path
import re
import shutil
import socket
import statistics
import subprocess
import sys
from urllib.parse import urlparse, urljoin

import requests

DOMINIOS = (
    "youtube.com", "youtu.be", "twitch.tv", "clips.twitch.tv",
    "kick.com", "tiktok.com", "instagram.com", "vimeo.com", "dailymotion.com",
)
# Fuentes públicas admitidas para archivos MP4/WebM: lista cerrada, sin URLs a redes internas.
DOMINIOS_DIRECTOS = (
    "archive.org", "upload.wikimedia.org", "github.com",
    "storage.googleapis.com", "r2.dev",
)
DOMINIOS_REDIRECT = DOMINIOS_DIRECTOS + (
    "release-assets.githubusercontent.com", "objects.githubusercontent.com",
)
EXTENSIONES_VIDEO = (".mp4", ".webm", ".mov", ".m4v")
MAX_DESCARGA = 750 * 1024 * 1024
MAX_DURACION = 30 * 60
MAX_CLIPS = 5


def dominio_permitido(host, directos=False, redireccion=False):
    permitidos = DOMINIOS_REDIRECT if redireccion else DOMINIOS_DIRECTOS if directos else DOMINIOS
    return any(host == d or host.endswith("." + d) for d in permitidos)


def enlace_directo(url):
    parts = urlparse(url)
    host = (parts.hostname or "").lower().rstrip(".")
    return dominio_permitido(host, directos=True) and parts.path.lower().endswith(EXTENSIONES_VIDEO)


def host_publico(host):
    try:
        ips = {item[4][0] for item in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
        return bool(ips) and all(ipaddress.ip_address(ip).is_global for ip in ips)
    except (OSError, ValueError):
        return False


def comprobar_url(url):
    url = url.strip()
    if len(url) > 500 or any(ord(c) < 32 for c in url):
        raise ValueError("El enlace es demasiado largo o inválido.")
    parts = urlparse(url)
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme != "https" or parts.username or parts.password or parts.port:
        raise ValueError("Usa enlaces HTTPS normales sin usuario, contraseña ni puerto.")
    if not (dominio_permitido(host) or enlace_directo(url)):
        raise ValueError("Fuente no admitida. Usa una plataforma compatible o un MP4/WebM público en un dominio permitido.")
    if enlace_directo(url):
        if any(x in parts.query.lower() for x in ("token=", "signature=", "x-amz-", "x-goog-", "apikey=", "api_key=", "auth=")):
            raise ValueError("No se aceptan enlaces con claves o firmas privadas.")
        if not host_publico(host):
            raise ValueError("El dominio del archivo no resuelve a una dirección pública.")
    if not parts.path or parts.path == "/":
        raise ValueError("Necesitas el enlace de un video concreto, no el perfil.")
    return url


def ejecutar(cmd, *, timeout=900, **kwargs):
    return subprocess.run(cmd, check=True, timeout=timeout, **kwargs)



def obtener_directo(url, carpeta):
    """Descarga un archivo de medios público con límites y redirecciones controladas."""
    destino = carpeta / ("source" + Path(urlparse(url).path).suffix.lower())
    actual = url
    sesion = requests.Session()
    sesion.trust_env = False
    try:
        for salto in range(6):
            parts = urlparse(actual)
            host = (parts.hostname or "").lower().rstrip(".")
            if parts.scheme != "https" or parts.username or parts.password or parts.port:
                raise RuntimeError("DIRECT_LINK_INVALID")
            if not dominio_permitido(host, redireccion=True) or not host_publico(host):
                raise RuntimeError("DIRECT_LINK_INVALID")
            try:
                respuesta = sesion.get(
                    actual, allow_redirects=False, stream=True,
                    timeout=(20, 45), headers={"Accept": "video/*, application/octet-stream"}
                )
            except requests.RequestException:
                raise RuntimeError("DIRECT_DOWNLOAD_FAILED") from None
            with respuesta:
                if respuesta.status_code in (301, 302, 303, 307, 308):
                    location = respuesta.headers.get("Location", "")
                    if not location or salto == 5:
                        raise RuntimeError("DIRECT_DOWNLOAD_FAILED")
                    actual = urljoin(actual, location)
                    continue
                if respuesta.status_code != 200:
                    raise RuntimeError("DIRECT_DOWNLOAD_FAILED")
                tipo = respuesta.headers.get("Content-Type", "").split(";", 1)[0].lower()
                if tipo and not (tipo.startswith("video/") or tipo in (
                    "application/octet-stream", "binary/octet-stream"
                )):
                    raise RuntimeError("DIRECT_LINK_INVALID")
                try:
                    esperado = int(respuesta.headers.get("Content-Length", "0"))
                except ValueError:
                    esperado = 0
                if esperado > MAX_DESCARGA:
                    raise RuntimeError("DIRECT_TOO_LARGE")
                total = 0
                try:
                    with destino.open("wb") as archivo:
                        for bloque in respuesta.iter_content(chunk_size=262144):
                            if not bloque:
                                continue
                            total += len(bloque)
                            if total > MAX_DESCARGA:
                                raise RuntimeError("DIRECT_TOO_LARGE")
                            archivo.write(bloque)
                except requests.RequestException:
                    raise RuntimeError("DIRECT_DOWNLOAD_FAILED") from None
                if total < 1024:
                    raise RuntimeError("DIRECT_LINK_INVALID")
                return destino
        raise RuntimeError("DIRECT_DOWNLOAD_FAILED")
    finally:
        sesion.close()


def obtener_archivo(url, carpeta):
    if enlace_directo(url):
        return obtener_directo(url, carpeta)
    plantilla = str(carpeta / "source.%(ext)s")
    try:
        ejecutar([
        sys.executable, "-m", "yt_dlp", "--no-playlist",
        "--js-runtimes", "node",
        "--no-progress", "--restrict-filenames", "--max-filesize", "750M",
        "--match-filter", "duration <= 1800 & !is_live",
        "--format", "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4", "-o", plantilla, "--", url,
        ], timeout=900, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        mensaje = (exc.stderr or "") + "\n" + (exc.stdout or "")
        texto = mensaje.lower()
        if "sign in to confirm" in texto or "not a bot" in texto:
            raise RuntimeError("YOUTUBE_VERIFICATION") from None
        if any(s in texto for s in ("private video", "video unavailable", "unsupported url", "not available", "login required")):
            raise RuntimeError("SOURCE_UNAVAILABLE") from None
        raise RuntimeError("DOWNLOAD_FAILED") from None
    encontrados = [p for p in carpeta.glob("source.*") if p.is_file() and p.suffix not in (".part", ".ytdl")]
    if not encontrados:
        raise RuntimeError("No se pudo descargar un video compatible con este enlace.")
    return max(encontrados, key=lambda p: p.stat().st_size)


def informacion(archivo):
    r = ejecutar([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nokey=1:noprint_wrappers=1", str(archivo),
    ], capture_output=True, text=True, timeout=30)
    seconds = float(r.stdout.strip())
    if not math.isfinite(seconds) or not (2 <= seconds <= MAX_DURACION):
        raise ValueError("Solo se aceptan videos grabados de entre 2 segundos y 30 minutos.")
    return seconds


def analizar_audio(archivo, duracion):
    """Calcula energía de audio por segundo; no guarda la grabación original."""
    try:
        r = ejecutar([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(archivo), "-vn", "-ac", "1", "-ar", "8000",
            "-f", "s16le", "pipe:1",
        ], capture_output=True, timeout=420)
        samples = array.array("h")
        samples.frombytes(r.stdout[: int(duracion + 1) * 8000 * 2])
        levels = []
        for start in range(0, len(samples), 8000):
            part = samples[start:start + 8000:20]
            if not part:
                break
            power = sum(v * v for v in part) / len(part)
            levels.append(20 * math.log10(max(1, math.sqrt(power)) / 32768))
        return levels
    except (OSError, subprocess.SubprocessError):
        return []


def analizar_escenas(archivo, duracion):
    """Usa únicamente fotogramas muestreados a baja resolución."""
    try:
        r = ejecutar([
            "ffmpeg", "-hide_banner", "-loglevel", "info", "-nostdin",
            "-t", str(duracion), "-i", str(archivo), "-an",
            "-vf", "fps=1/3,scale=160:90,select='gt(scene,0.22)',showinfo",
            "-f", "null", "-",
        ], capture_output=True, text=True, timeout=420)
        return [float(t) for t in re.findall(r"showinfo.*?pts_time:\s*([\d.]+)", r.stderr)]
    except (OSError, subprocess.SubprocessError):
        return []


def elegir_momentos(duracion, longitud, levels, scenes, numero=5):
    longitud = max(3, min(float(longitud), duracion))
    baseline = statistics.median(levels) if levels else -45
    candidatos = []
    upper = max(0, duracion - longitud)
    intervalos = sorted(set([0.0, upper] + [min(upper, max(0.0, t - 5)) for t in range(0, int(duracion), 3)] + [max(0.0, min(upper, t - 5)) for t in scenes]))
    for start in intervalos:
        end = min(duracion, start + longitud)
        idx0, idx1 = int(start), min(len(levels), int(math.ceil(end)))
        audio = levels[idx0:idx1]
        # Premia picos de voz/reacción, no simplemente música constante.
        top = sorted(audio, reverse=True)[: max(1, int(len(audio) * .2))]
        loudness = max(0, min(1, (statistics.mean(top) - baseline) / 14)) if top else 0
        cuts = sum(1 for s in scenes if start <= s < end)
        scene = min(1, cuts / max(1, longitud / 12))
        score = (.68 * loudness + .32 * scene) if levels else scene
        candidatos.append({"start": round(start, 2), "end": round(end, 2), "score": round(score, 3), "audio": round(loudness, 3), "scene": round(scene, 3)})
    seleccion = []
    for c in sorted(candidatos, key=lambda x: (-x["score"], x["start"])):
        # No generar varios clips prácticamente iguales.
        if any(abs(c["start"] - prev["start"]) < longitud * .83 for prev in seleccion):
            continue
        seleccion.append(c)
        if len(seleccion) >= numero:
            break
    return seleccion or [{"start": 0, "end": duracion, "score": 0, "audio": 0, "scene": 0}]


def exportar(archivo, momentos, salida):
    salida.mkdir(parents=True, exist_ok=True)
    for i, c in enumerate(momentos, 1):
        destino = salida / f"clip_{i:02d}_vertical.mp4"
        ejecutar([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-ss", str(c["start"]), "-i", str(archivo), "-t", str(c["end"] - c["start"]),
            "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-r", "30",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(destino),
        ], timeout=420)
        if not destino.is_file() or destino.stat().st_size < 512:
            raise RuntimeError(f"Falló la exportación del clip {i}.")
        c["archivo"] = destino.name


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=False, default=os.getenv("VIDEO_URL", ""))
    p.add_argument("--duracion", type=int, default=int(os.getenv("CLIP_SECONDS", "30")))
    p.add_argument("--carpeta", default="clips_generados")
    p.add_argument("--archivo-local", help="Solo pruebas; evita descargar un video.")
    a = p.parse_args()
    if not 15 <= a.duracion <= 60:
        p.error("La duración de cada clip debe estar entre 15 y 60 segundos.")
    url = comprobar_url(a.url) if not a.archivo_local else "prueba-local"
    salida = Path(a.carpeta).resolve()
    salida.mkdir(parents=True, exist_ok=True)
    carpeta = salida.parent / "video_temporal"
    carpeta.mkdir(parents=True, exist_ok=True)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("FFMPEG_MISSING")
    archivo = Path(a.archivo_local).resolve() if a.archivo_local else obtener_archivo(url, carpeta)
    duracion = informacion(archivo)
    print(f"Video de {duracion:.0f} segundos. Buscando momentos destacados...", flush=True)
    levels = analizar_audio(archivo, duracion)
    scenes = analizar_escenas(archivo, duracion)
    momentos = elegir_momentos(duracion, a.duracion, levels, scenes, numero=MAX_CLIPS)
    exportar(archivo, momentos, salida)
    (salida / "recortes.json").write_text(json.dumps({
        "fuente": url, "duracion_original": duracion, "metodo": "picos_de_audio_y_cambios_visuales",
        "aviso": "Selección automática orientativa. Revisa cada clip antes de publicarlo.",
        "clips": momentos,
    }, ensure_ascii=False, indent=2), encoding="utf8")
    (salida / "LEEME.txt").write_text(
        "GTA VI CLIP FORGE — Clips automáticos gratuitos\n\n"
        "1. Extrae los archivos MP4 de este ZIP.\n"
        "2. Abre https://abcden.github.io/views/#editor\n"
        "3. Selecciona cualquier MP4 para recortarlo, añadir texto y descargarlo.\n"
        "La selección usa audio y cambios de escena, NO inteligencia semántica.\n"
        "El archivo original no se almacena en el repositorio.\n",
        encoding="utf8",
    )
    print(f"Listos {len(momentos)} clips MP4 y una receta editable.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        codigo = str(exc) if str(exc) in {
            "YOUTUBE_VERIFICATION", "SOURCE_UNAVAILABLE", "DOWNLOAD_FAILED", "FFMPEG_MISSING",
            "DIRECT_LINK_INVALID", "DIRECT_DOWNLOAD_FAILED", "DIRECT_TOO_LARGE"
        } else "PROCESSING_FAILED"
        carpeta_error = Path(os.getenv("CLIP_ERROR_DIR", "clips_generados"))
        carpeta_error.mkdir(parents=True, exist_ok=True)
        (carpeta_error / "error.json").write_text(
            json.dumps({"code": codigo}, ensure_ascii=False), encoding="utf8"
        )
        print(f"CLIP_FORGE_ERROR: {codigo}", file=sys.stderr, flush=True)
        sys.exit(1)
