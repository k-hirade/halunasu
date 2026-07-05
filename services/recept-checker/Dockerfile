FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY README.md check_cli.py run.py ./
COPY receipt_checker ./receipt_checker
COPY sample_data ./sample_data

EXPOSE 8080

CMD ["python", "run.py", "--host", "0.0.0.0"]
