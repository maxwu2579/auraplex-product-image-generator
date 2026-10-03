from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app import main

client = TestClient(main.app)


def image_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (8, 8), "white").save(output, format="JPEG")
    return output.getvalue()


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_png_response(monkeypatch):
    expected = b"processed-png"
    monkeypatch.setattr(main, "process_image", lambda content: expected)
    response = client.post(
        "/api/images/remove-background",
        files={"file": ("product.jpg", image_bytes(), "image/jpeg")},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert response.content == expected


def test_unsupported_type():
    response = client.post(
        "/api/images/remove-background",
        files={"file": ("product.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 415


def test_oversized_upload(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
    response = client.post(
        "/api/images/remove-background",
        files={"file": ("product.jpg", b"x" * 11, "image/jpeg")},
    )
    assert response.status_code == 413


def test_processing_error_is_safe(monkeypatch):
    def fail(_content):
        raise RuntimeError("private stack detail")

    monkeypatch.setattr(main, "process_image", fail)
    response = client.post(
        "/api/images/remove-background",
        files={"file": ("product.jpg", image_bytes(), "image/jpeg")},
    )
    assert response.status_code == 503
    assert "private stack detail" not in response.text


def test_subject_detection_response(monkeypatch):
    monkeypatch.setattr(main, "process_subjects", lambda _: {
        "whole": {"png": b"whole-png", "width": 10, "height": 8},
        "candidates": [{"id": "subject-1", "png": b"subject-png", "width": 5, "height": 6, "area": 30, "small": False}],
        "warning": None,
    })
    response = client.post("/api/images/detect-subjects", files={"file": ("product.jpg", image_bytes(), "image/jpeg")})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["whole"]["pngBase64"] == "d2hvbGUtcG5n"
    assert response.json()["candidates"][0]["id"] == "subject-1"


def test_subject_detection_upload_validation():
    response = client.post("/api/images/detect-subjects", files={"file": ("bad.txt", b"bad", "text/plain")})
    assert response.status_code == 415
