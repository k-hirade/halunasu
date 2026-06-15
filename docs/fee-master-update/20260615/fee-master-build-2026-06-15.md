# Standard Master DB Build

| Status | Count |
| --- | ---: |
| ok | 43 |
| error | 0 |

| Status | Kind | Rows | Source ID | Path | Error |
| --- | --- | ---: | ---: | --- | --- |
| ok | medical_procedure_master | 11746 | 1 | data/raw/ssk/medical_procedure_master/2026-06-15/s_ALL20260605/s_ALL20260605.csv |  |
| ok | drug_master | 18495 | 2 | data/raw/ssk/drug_master/2026-06-15/y_ALL20260611/y_ALL20260611.csv |  |
| ok | specific_material_master | 1395 | 3 | data/raw/ssk/specific_material_master/2026-06-15/t_ALL20260529/t_ALL20260529.csv |  |
| ok | comment_master | 4593 | 4 | data/raw/ssk/comment_master/2026-06-15/c_ALL20260605/c_ALL20260605.csv |  |
| ok | comment_related_table | 18201 | 5 | data/raw/ssk/comment_related_table/2026-06-15/ck_ALL_20260605/ck_ALL_20260605.csv |  |
| ok | medical_electronic_fee_table | 350054 | 6 | aux_master=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/01 補助マスターテーブル.csv,bundles=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/02 包括テーブル.csv,exclusions_day=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/03-1 背反テーブル1.csv,exclusions_month=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/03-2 背反テーブル2.csv,exclusions_simultaneous=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/03-3 背反テーブル3.csv,exclusions_week=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/03-4 背反テーブル4.csv,frequency_limits=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/05 算定回数テーブル.csv,inpatient_basic=data/raw/ssk/medical_electronic_fee_table/2026-06-15/tensuhyo_02/04 入院基本料テーブル.csv |  |
| ok | regional_hokkaido_hospital_registry | 519 | 7 | data/raw/kouseikyoku/hokkaido/2026-05-01/hospital_registry/000482050.xlsx |  |
| ok | regional_hokkaido_facility_standards | 37727 | 8 | data/raw/kouseikyoku/hokkaido/2026-05-01/facility_standards/000482062.xlsx |  |
| ok | regional_tohoku_hospital_registry | 709 | 9 | data/raw/kouseikyoku/tohoku/2026-05-01/hospital_registry/shitei-touhoku-ika-r0805.xlsx |  |
| ok | regional_tohoku_hospital_registry | 3 | 10 | data/raw/kouseikyoku/tohoku/2026-05-01/hospital_registry/shitei-touhoku-ikaheisetsu-r0805.xlsx |  |
| ok | regional_tohoku_facility_standards | 702 | 11 | data/raw/kouseikyoku/tohoku/2026-05-01/facility_standards/koumoku01-touhoku-ika-r0804.xlsx |  |
| ok | regional_tohoku_facility_standards | 11430 | 12 | data/raw/kouseikyoku/tohoku/2026-05-01/facility_standards/shisetsu-touhoku-ika-r0804.xlsx |  |
| ok | regional_kanto_shinetsu_hospital_registry | 34854 | 13 | data/raw/kouseikyoku/kanto_shinetsu/2026-05-01/hospital_registry/shitei_ika_r0805-1.zip |  |
| ok | regional_kanto_shinetsu_facility_standards | 283750 | 14 | data/raw/kouseikyoku/kanto_shinetsu/2026-05-01/facility_standards/shisetsu_ika_r0805.zip |  |
| ok | regional_kanto_shinetsu_facility_standards | 27608 | 15 | data/raw/kouseikyoku/kanto_shinetsu/2026-05-01/facility_standards/koumokubetsu1_r0805.zip |  |
| ok | regional_kanto_shinetsu_facility_standards | 16195 | 16 | data/raw/kouseikyoku/kanto_shinetsu/2026-05-01/facility_standards/koumokubetsu2_r0805.zip |  |
| ok | regional_tokai_hokuriku_hospital_registry | 11805 | 17 | data/raw/kouseikyoku/tokai_hokuriku/2026-05-01/hospital_registry/2605-01-01.zip |  |
| ok | regional_tokai_hokuriku_facility_standards | 170459 | 18 | data/raw/kouseikyoku/tokai_hokuriku/2026-05-01/facility_standards/2605-06_01-01.zip |  |
| ok | regional_kinki_hospital_registry | 19842 | 19 | data/raw/kouseikyoku/kinki/2026-05-01/hospital_registry/2026.5_kikanzentai_ika.zip |  |
| ok | regional_kinki_facility_standards | 172122 | 20 | data/raw/kouseikyoku/kinki/2026-05-01/facility_standards/2026.5_sisetukijun_ika.zip |  |
| ok | regional_kinki_facility_standards | 9537 | 21 | data/raw/kouseikyoku/kinki/2026-05-01/facility_standards/2026.5_nyuuin.xlsx |  |
| ok | regional_kinki_facility_standards | 10609 | 22 | data/raw/kouseikyoku/kinki/2026-05-01/facility_standards/2026.5_tokutei.xlsx |  |
| ok | regional_chugoku_shikoku_hospital_registry | 5912 | 23 | data/raw/kouseikyoku/chugoku_shikoku/2026-05-01/hospital_registry/000483046.zip |  |
| ok | regional_chugoku_shikoku_facility_standards | 124139 | 24 | data/raw/kouseikyoku/chugoku_shikoku/2026-05-01/facility_standards/000485758.zip |  |
| ok | regional_shikoku_hospital_registry | 3004 | 25 | data/raw/kouseikyoku/shikoku/2026-05-01/hospital_registry/000482152.zip |  |
| ok | regional_shikoku_facility_standards | 5285 | 26 | data/raw/kouseikyoku/shikoku/2026-05-01/facility_standards/000482227.zip |  |
| ok | regional_shikoku_facility_standards | 53636 | 27 | data/raw/kouseikyoku/shikoku/2026-05-01/facility_standards/000482171.zip |  |
| ok | regional_kyushu_hospital_registry | 4528 | 28 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483280.zip |  |
| ok | regional_kyushu_hospital_registry | 666 | 29 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483282.zip |  |
| ok | regional_kyushu_hospital_registry | 1169 | 30 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483283.zip |  |
| ok | regional_kyushu_hospital_registry | 1374 | 31 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483284.zip |  |
| ok | regional_kyushu_hospital_registry | 921 | 32 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483285.zip |  |
| ok | regional_kyushu_hospital_registry | 837 | 33 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483288.zip |  |
| ok | regional_kyushu_hospital_registry | 1280 | 34 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483289.zip |  |
| ok | regional_kyushu_hospital_registry | 915 | 35 | data/raw/kouseikyoku/kyushu/2026-05-01/hospital_registry/000483290.zip |  |
| ok | regional_kyushu_facility_standards | 113818 | 36 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483237.zip |  |
| ok | regional_kyushu_facility_standards | 20137 | 37 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483238.zip |  |
| ok | regional_kyushu_facility_standards | 30434 | 38 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483239.zip |  |
| ok | regional_kyushu_facility_standards | 40289 | 39 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483240.zip |  |
| ok | regional_kyushu_facility_standards | 27302 | 40 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483241.zip |  |
| ok | regional_kyushu_facility_standards | 23106 | 41 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483242.zip |  |
| ok | regional_kyushu_facility_standards | 38879 | 42 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483243.zip |  |
| ok | regional_kyushu_facility_standards | 21156 | 43 | data/raw/kouseikyoku/kyushu/2026-05-01/facility_standards/000483244.zip |  |

Total entries: 43
