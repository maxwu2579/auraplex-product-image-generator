import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.brand_library import BrandLibrary, BrandLibraryError, normalize_brand


def picture(mode="RGB", format="JPEG", color="red"):
    output = BytesIO()
    Image.new(mode, (24, 16), color).save(output, format=format)
    return output.getvalue()


@pytest.fixture
def library(tmp_path, monkeypatch):
    local = BrandLibrary(tmp_path / "brands")
    monkeypatch.setattr(main, "brand_library", local)
    return local


def upload(name="BMW", *, processed=True, method="post", original=None):
    files = {"file": ("logo.jpg", original or picture(), "image/jpeg")}
    if processed:
        files["processed_file"] = ("logo.png", picture("RGBA", "PNG", (255, 0, 0, 180)), "image/png")
    return TestClient(main.app).request(method, f"/api/brands/{name}",
                                        data={"display_name": name, "remove_background": str(processed).lower()}, files=files)


def test_normalization_and_invalid_names():
    assert {normalize_brand(value) for value in ("BMW", "bmw", " BMW ")} == {"bmw"}
    assert normalize_brand("Mercedes Benz") == normalize_brand("Mercedes-Benz") == "mercedes-benz"
    assert normalize_brand(" Mercedes__Benz ") == "mercedes-benz"
    for raw in ("", " ../ ", "中文", "___"):
        with pytest.raises(BrandLibraryError):
            normalize_brand(raw)


def test_lookup_save_assets_and_restart(library):
    client = TestClient(main.app)
    assert client.get("/api/brands/BMW").json() == {"found": False, "key": "bmw"}
    response = upload()
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["brand"]["remove_background"] is True
    manifest = json.loads(library.manifest.read_text(encoding="utf-8"))
    assert list(manifest) == ["bmw"]
    assert (library.root / manifest["bmw"]["original_file"]).is_file()
    assert (library.root / manifest["bmw"]["display_file"]).is_file()
    assert client.get(saved["brand"]["display_url"]).headers["content-type"] == "image/png"
    assert client.get(saved["brand"]["original_url"]).headers["content-type"] == "image/jpeg"
    restarted = BrandLibrary(library.root)
    assert restarted.lookup(" bmw ")["brand"]["display_name"] == "BMW"


def test_no_silent_overwrite_and_explicit_replace(library):
    assert upload().status_code == 200
    before = library.lookup("BMW")
    assert upload(original=picture(color="blue")).status_code == 409
    assert library.lookup("BMW") == before
    result = upload(method="put", original=picture(color="blue"))
    assert result.status_code == 200, result.text
    manifest = json.loads(library.manifest.read_text(encoding="utf-8"))
    assert list(manifest) == ["bmw"]
    assert TestClient(main.app).get(result.json()["brand"]["original_url"]).content == picture(color="blue")


def test_background_off_saves_original_as_display(library):
    response = upload("Toyota", processed=False)
    assert response.status_code == 200, response.text
    entry = json.loads(library.manifest.read_text(encoding="utf-8"))["toyota"]
    assert entry["original_file"] == entry["display_file"]
    assert BrandLibrary(library.root).lookup("toyota")["brand"]["remove_background"] is False


def test_corrupt_manifest_is_not_overwritten(library):
    library.root.mkdir(parents=True)
    library.manifest.write_text("not-json", encoding="utf-8")
    assert TestClient(main.app).get("/api/brands/BMW").status_code == 503
    assert upload().status_code == 503
    assert library.manifest.read_text(encoding="utf-8") == "not-json"


def test_invalid_upload_and_path_safety(library):
    client = TestClient(main.app)
    result = client.post("/api/brands/BMW", data={"display_name": "BMW", "remove_background": "false"},
                         files={"file": ("bad.jpg", b"not an image", "image/jpeg")})
    assert result.status_code == 422
    assert not library.manifest.exists()
    assert client.get("/api/brands/../assets/original").status_code in (404, 422)
    assert client.get("/api/brands/bmw/assets/../secret").status_code in (404, 422)
    assert client.get("/api/brands/bmw/assets/other").status_code == 404


def test_manifest_cannot_serve_files_outside_library(library):
    library.root.mkdir(parents=True)
    library.manifest.write_text(json.dumps({"bmw": {
        "display_name": "BMW", "original_file": "bmw/../../secret.jpg",
        "display_file": "bmw/../../secret.jpg", "remove_background": False,
    }}), encoding="utf-8")
    client = TestClient(main.app)
    assert client.get("/api/brands/bmw").status_code == 503
    assert client.get("/api/brands/bmw/assets/display").status_code == 503


def test_failed_replace_preserves_previous_entry(library, monkeypatch):
    assert upload().status_code == 200
    previous = library.manifest.read_bytes()
    previous_logo = library.asset("bmw", "display").read_bytes()
    real_replace = __import__("os").replace

    def fail_manifest(source, destination):
        if destination == library.manifest:
            raise OSError("test write failure")
        return real_replace(source, destination)

    monkeypatch.setattr("app.brand_library.os.replace", fail_manifest)
    assert upload(method="put", original=picture(color="blue")).status_code == 503
    assert library.manifest.read_bytes() == previous
    assert library.asset("bmw", "display").read_bytes() == previous_logo
