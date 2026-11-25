# syntax=docker/dockerfile:1
# rci-api — Django + DRF API served by gunicorn on the private rci-internal
# network. Only rci-gateway can reach it; no host port is published.

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt "gunicorn>=23,<24"

COPY . .
# SQLite lives on the rci-data volume (DATABASE_URL points at /data).
RUN mkdir -p /data

EXPOSE 8000

CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py collectstatic --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers ${GUNICORN_WORKERS:-3} --timeout 60 --access-logfile - --error-logfile -"]
