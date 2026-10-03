from io import BytesIO

from PIL import Image, ImageDraw

from app.image_processing import subjects


def canvas() -> Image.Image:
    return Image.new("RGBA", (120, 90), (0, 0, 0, 0))


def test_single_subject_is_cropped_and_transparent():
    image = canvas()
    ImageDraw.Draw(image).rectangle((12, 10, 47, 55), fill=(200, 30, 20, 255))
    candidates, warning = subjects.detect_components(image)
    assert warning is None
    assert len(candidates) == 1
    assert candidates[0]["small"] is False
    with Image.open(BytesIO(candidates[0]["png"])) as crop:
        assert crop.size == (36, 46)
        assert crop.mode == "RGBA"


def test_separate_subjects_and_small_mark_are_preserved():
    image = canvas()
    draw = ImageDraw.Draw(image)
    draw.rectangle((5, 5, 35, 45), fill=(200, 30, 20, 255))
    draw.rectangle((65, 8, 100, 48), fill=(20, 30, 200, 255))
    draw.rectangle((110, 75, 112, 77), fill=(0, 0, 0, 255))
    candidates, _ = subjects.detect_components(image)
    assert len(candidates) == 3
    assert [item["small"] for item in candidates] == [False, False, True]
    with Image.open(BytesIO(candidates[0]["png"])) as crop:
        assert crop.getpixel((0, 0))[3] == 255


def test_touching_objects_stay_one_candidate():
    image = canvas()
    draw = ImageDraw.Draw(image)
    draw.rectangle((5, 5, 38, 42), fill=(200, 30, 20, 255))
    draw.rectangle((38, 25, 75, 62), fill=(20, 30, 200, 255))
    candidates, _ = subjects.detect_components(image)
    assert len(candidates) == 1


def test_analysis_failure_keeps_whole_processed_image(monkeypatch):
    image = canvas()
    ImageDraw.Draw(image).rectangle((10, 10, 60, 60), fill=(200, 30, 20, 255))
    monkeypatch.setattr(subjects, "process_to_rgba", lambda _: image)
    def fail(_image):
        raise RuntimeError("analysis failure")
    monkeypatch.setattr(subjects, "detect_components", fail)
    result = subjects.process_subjects(b"source")
    assert result["whole"]["width"] == 120
    assert result["candidates"] == []
    assert result["warning"]
