from medical_fee_calculation import __version__


def test_medical_fee_calculation_package_imports() -> None:
    assert __version__ == "0.1.0"


if __name__ == "__main__":
    test_medical_fee_calculation_package_imports()
