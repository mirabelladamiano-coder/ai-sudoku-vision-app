import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
  Linking,
  Animated,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.EXPO_PUBLIC_GEMINI_API_KEY });

const createEmptyGrid = () => Array.from({ length: 9 }, () => Array(9).fill(0));
const cloneGrid = (grid) => grid.map((row) => [...row]);

const SAMPLE_SUDOKU_GRID = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isQuotaExceededError = (err) => {
  const msg = String(err?.message || '');
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Quota exceeded') ||
    msg.includes('quota')
  );
};

const isTemporaryServerError = (err) => {
  const msg = String(err?.message || '');
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand')
  );
};

async function callGeminiWithRetry(requestFn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;
      if (isQuotaExceededError(err) || !isTemporaryServerError(err) || attempt === maxRetries) {
        throw err;
      }
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastError;
}

function getValidCandidates(grid, r, c) {
  if (grid[r][c] !== 0) return [];
  const used = new Set();

  for (let i = 0; i < 9; i++) {
    if (grid[r][i] !== 0) used.add(grid[r][i]);
    if (grid[i][c] !== 0) used.add(grid[i][c]);
  }

  const boxRow = Math.floor(r / 3) * 3;
  const boxCol = Math.floor(c / 3) * 3;
  for (let r2 = boxRow; r2 < boxRow + 3; r2++) {
    for (let c2 = boxCol; c2 < boxCol + 3; c2++) {
      if (grid[r2][c2] !== 0) used.add(grid[r2][c2]);
    }
  }

  const candidates = [];
  for (let num = 1; num <= 9; num++) {
    if (!used.has(num)) candidates.push(num);
  }
  return candidates;
}

function hasGridConflicts(grid) {
  for (let r = 0; r < 9; r++) {
    const seen = new Set();
    for (let c = 0; c < 9; c++) {
      const v = grid[r][c];
      if (v !== 0) {
        if (seen.has(v)) return `Duplicato del numero ${v} nella riga ${r + 1}`;
        seen.add(v);
      }
    }
  }

  for (let c = 0; c < 9; c++) {
    const seen = new Set();
    for (let r = 0; r < 9; r++) {
      const v = grid[r][c];
      if (v !== 0) {
        if (seen.has(v)) return `Duplicato del numero ${v} nella colonna ${c + 1}`;
        seen.add(v);
      }
    }
  }

  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Set();
      for (let r = br * 3; r < br * 3 + 3; r++) {
        for (let c = bc * 3; c < bc * 3 + 3; c++) {
          const v = grid[r][c];
          if (v !== 0) {
            if (seen.has(v)) {
              return `Duplicato del numero ${v} nel blocco (${br + 1},${bc + 1})`;
            }
            seen.add(v);
          }
        }
      }
    }
  }

  return null;
}

function solveSudokuBacktracking(inputGrid) {
  if (hasGridConflicts(inputGrid)) return null;
  const grid = cloneGrid(inputGrid);

  const backtrack = () => {
    let bestCell = null;
    let bestCandidates = null;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (grid[r][c] === 0) {
          const candidates = getValidCandidates(grid, r, c);
          if (candidates.length === 0) return false;
          if (!bestCandidates || candidates.length < bestCandidates.length) {
            bestCell = { r, c };
            bestCandidates = candidates;
            if (candidates.length === 1) break;
          }
        }
      }
      if (bestCandidates && bestCandidates.length === 1) break;
    }

    if (!bestCell) return true;

    const { r, c } = bestCell;
    for (const num of bestCandidates) {
      grid[r][c] = num;
      if (backtrack()) return true;
      grid[r][c] = 0;
    }

    return false;
  };

  return backtrack() ? grid : null;
}

function getLocalMoveForTarget(inputGrid, preferredCell = null, preferredBlock = null) {
  const conflict = hasGridConflicts(inputGrid);
  if (conflict) {
    return { error: `Griglia non valida: ${conflict}.` };
  }

  const solved = solveSudokuBacktracking(inputGrid);
  if (!solved) {
    return {
      error:
        'Questa griglia non ha una soluzione valida in locale. Controlla eventuali cifre inserite a mano.',
    };
  }

  if (preferredCell) {
    const { row, col } = preferredCell;
    if (inputGrid[row][col] !== 0) {
      return {
        error: `La cella Riga ${row + 1}, Colonna ${col + 1} contiene già ${inputGrid[row][col]}. Seleziona una cella vuota per suggerire una mossa.`,
      };
    }
    const candidates = getValidCandidates(inputGrid, row, col);
    const val = solved[row][col];
    return {
      hint: {
        row,
        col,
        valore: val,
        spiegazione:
          candidates.length === 1
            ? `Nella cella scelta (Riga ${row + 1}, Colonna ${col + 1}) l'unico numero possibile è ${val}.`
            : `Nella cella scelta (Riga ${row + 1}, Colonna ${col + 1}), tra i candidati [${candidates.join(', ')}], il valore corretto per completare lo schema è ${val}.`,
      },
    };
  }

  const pickBestCellInRange = (rStart, rEnd, cStart, cEnd, scopeLabel) => {
    let bestNakedSingle = null;
    let bestMrvCell = null;

    for (let r = rStart; r < rEnd; r++) {
      for (let c = cStart; c < cEnd; c++) {
        if (inputGrid[r][c] === 0) {
          const candidates = getValidCandidates(inputGrid, r, c);
          if (candidates.length === 0) continue;

          if (candidates.length === 1 && !bestNakedSingle) {
            bestNakedSingle = {
              row: r,
              col: c,
              valore: candidates[0],
              spiegazione: `${scopeLabel}, in Riga ${r + 1}, Colonna ${c + 1} c'è un solo numero valido (${candidates[0]}) rispetto a riga, colonna e blocco 3x3.`,
            };
          }

          if (!bestMrvCell || candidates.length < bestMrvCell.count) {
            bestMrvCell = {
              row: r,
              col: c,
              count: candidates.length,
              valore: solved[r][c],
              spiegazione: `${scopeLabel}, in Riga ${r + 1}, Colonna ${c + 1} (soli ${candidates.length} candidati: [${candidates.join(', ')}]), il valore corretto è ${solved[r][c]}.`,
            };
          }
        }
      }
    }

    if (bestNakedSingle) return bestNakedSingle;
    if (bestMrvCell) {
      const { row, col, valore, spiegazione } = bestMrvCell;
      return { row, col, valore, spiegazione };
    }
    return null;
  };

  if (preferredBlock) {
    const { br, bc } = preferredBlock;
    const blockHint = pickBestCellInRange(
      br * 3,
      br * 3 + 3,
      bc * 3,
      bc * 3 + 3,
      `Nel blocco (${br + 1},${bc + 1})`
    );
    if (!blockHint) {
      return { error: `Il blocco (${br + 1},${bc + 1}) non ha celle vuote risolvibili.` };
    }
    return { hint: blockHint };
  }

  const autoHint = pickBestCellInRange(0, 9, 0, 9, 'Analizzando i vincoli della griglia');
  if (!autoHint) {
    return { error: 'Il Sudoku è già completo o non ci sono mosse disponibili.' };
  }
  return { hint: autoHint };
}

function verifyOrSuggestMoveLocal(
  inputGrid,
  interaction = 'edit',
  preferredCell = null,
  preferredBlock = null,
  editedCell = null
) {
  // 1. Verifica Blocco: cerca esclusivamente dentro il blocco 3x3 scelto
  if (interaction === 'block' && preferredBlock) {
    return getLocalMoveForTarget(inputGrid, null, preferredBlock);
  }

  // 2. Verifica Cella: controlla esclusivamente la cella selezionata (o suggerisce se vuota)
  if (interaction === 'cell' && preferredCell) {
    const { row, col } = preferredCell;
    const cellVal = inputGrid[row][col];

    if (cellVal === 0) {
      return getLocalMoveForTarget(inputGrid, preferredCell, null);
    }

    const tempWithoutCell = cloneGrid(inputGrid);
    tempWithoutCell[row][col] = 0;
    const validNow = getValidCandidates(tempWithoutCell, row, col).includes(cellVal);
    const solvedWithCell = solveSudokuBacktracking(inputGrid);
    const solvedWithoutCell = solveSudokuBacktracking(tempWithoutCell);

    if (validNow && solvedWithCell) {
      return {
        hint: {
          row,
          col,
          valore: cellVal,
          insertedValue: cellVal,
          isRight: true,
          spiegazione: `Mossa GIUSTA! Il numero ${cellVal} in Riga ${row + 1}, Colonna ${col + 1} rispetta riga, colonna e blocco 3x3 e mantiene risolvibile lo schema.`,
        },
      };
    }

    const suggestedVal = solvedWithoutCell ? solvedWithoutCell[row][col] : null;
    return {
      hint: {
        row,
        col,
        valore: suggestedVal,
        insertedValue: cellVal,
        isRight: false,
        spiegazione: !validNow
          ? `Mossa SBAGLIATA! Il numero ${cellVal} è già presente nella stessa riga, colonna o blocco 3x3 di Riga ${row + 1}, Colonna ${col + 1}.${suggestedVal ? ` Un valore valido è ${suggestedVal}.` : ''}`
          : `Mossa SBAGLIATA! Con il numero ${cellVal} in Riga ${row + 1}, Colonna ${col + 1} la griglia non è risolvibile.${suggestedVal ? ` Un valore valido è ${suggestedVal}.` : ''}`,
      },
    };
  }

  // 3. Correggi Cella: se è stata appena modificata una cella con valore > 0, verifica solo quella
  if (interaction === 'edit' && editedCell && inputGrid[editedCell.row]?.[editedCell.col] !== 0) {
    const { row, col } = editedCell;
    const userVal = inputGrid[row][col];
    const tempWithoutCell = cloneGrid(inputGrid);
    tempWithoutCell[row][col] = 0;
    const validNow = getValidCandidates(tempWithoutCell, row, col).includes(userVal);
    const solvedWithCell = solveSudokuBacktracking(inputGrid);
    const solvedWithoutCell = solveSudokuBacktracking(tempWithoutCell);

    if (validNow && solvedWithCell) {
      return {
        hint: {
          row,
          col,
          valore: userVal,
          insertedValue: userVal,
          isRight: true,
          spiegazione: `Mossa GIUSTA! Il numero ${userVal} inserito in Riga ${row + 1}, Colonna ${col + 1} rispetta riga, colonna e blocco 3x3 e mantiene risolvibile lo schema.`,
        },
      };
    }

    const suggestedVal = solvedWithoutCell ? solvedWithoutCell[row][col] : null;
    return {
      hint: {
        row,
        col,
        valore: suggestedVal,
        insertedValue: userVal,
        isRight: false,
        spiegazione: !validNow
          ? `Mossa SBAGLIATA! Il numero ${userVal} crea un conflitto in riga, colonna o blocco 3x3 in Riga ${row + 1}, Colonna ${col + 1}.${suggestedVal ? ` Un valore valido è ${suggestedVal}.` : ''}`
          : `Mossa SBAGLIATA! Con ${userVal} in Riga ${row + 1}, Colonna ${col + 1} la griglia non ammette soluzione.${suggestedVal ? ` Un valore valido è ${suggestedVal}.` : ''}`,
      },
    };
  }

  return getLocalMoveForTarget(inputGrid, null, null);
}

export default function App() {
  const [selectedMode, setSelectedMode] = useState('move'); // 'move' | 'solve'
  const [localOnlyMode, setLocalOnlyMode] = useState(true);

  // 'edit' | 'cell' | 'block'
  const [gridInteraction, setGridInteraction] = useState('edit');
  const [chosenBlock, setChosenBlock] = useState({ br: 0, bc: 0 });

  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [grid, setGrid] = useState(createEmptyGrid());
  const [hasGrid, setHasGrid] = useState(false);
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastEditedCell, setLastEditedCell] = useState(null);

  const [moveHint, setMoveHint] = useState(null);
  const [hintLevel, setHintLevel] = useState(1);

  const [solvedGrid, setSolvedGrid] = useState(null);

  const [showOverlay, setShowOverlay] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.07, duration: 750, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      Speech.stop?.();
    };
  }, [pulseAnim]);

  const getAvatarState = () => {
    if (errorMsg) return { emoji: '🤔', label: 'Controlliamo insieme' };
    if (loading) return { emoji: '🧠', label: 'Sto ragionando...' };
    if (solvedGrid) return { emoji: '🎉', label: 'Sudoku completato!' };
    if (moveHint?.isRight === true) return { emoji: '✅', label: 'Mossa giusta!' };
    if (moveHint?.isRight === false) return { emoji: '❌', label: 'Mossa sbagliata' };
    if (moveHint) return { emoji: '💡', label: 'Ho trovato una mossa!' };
    return { emoji: '🦉', label: 'Pronto ad aiutarti' };
  };

  const toggleSpeakExplanation = (text) => {
    if (!text) return;
    if (isSpeaking) {
      Speech.stop?.();
      setIsSpeaking(false);
      return;
    }
    setIsSpeaking(true);
    Speech.speak?.(text, {
      language: 'it-IT',
      rate: 0.98,
      onDone: () => setIsSpeaking(false),
      onStopped: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  };

  const applyLocalModeResult = (
    targetGrid,
    modeToRun,
    interaction = gridInteraction,
    cellOverride = selectedCell,
    blockOverride = chosenBlock,
    editedOverride = lastEditedCell
  ) => {
    if (modeToRun === 'move') {
      setSolvedGrid(null);
      const prefCell = interaction === 'cell' ? cellOverride : null;
      const prefBlock = interaction === 'block' ? blockOverride : null;
      const activeEdited = interaction === 'edit' ? editedOverride : null;
      const res = verifyOrSuggestMoveLocal(
        targetGrid,
        interaction,
        prefCell,
        prefBlock,
        activeEdited
      );
      if (res.hint) {
        setMoveHint(res.hint);
        setHintLevel(res.hint.isRight !== undefined ? 3 : 1);
        setErrorMsg('');
      } else {
        setMoveHint(null);
        setErrorMsg(res.error || 'Nessuna mossa trovata.');
      }
    } else {
      setMoveHint(null);
      const sol = solveSudokuBacktracking(targetGrid);
      if (sol) {
        setSolvedGrid(sol);
        setErrorMsg('');
      } else {
        setSolvedGrid(null);
        setErrorMsg('Griglia non risolvibile in locale: verifica eventuali cifre errate.');
      }
    }
  };

  const loadSampleSudokuWithImage = (uri, modeToRun = selectedMode) => {
    Speech.stop?.();
    setIsSpeaking(false);
    setErrorMsg('');
    setImage(uri);
    setSelectedCell(null);
    setLastEditedCell(null);
    setHintLevel(1);

    const sample = cloneGrid(SAMPLE_SUDOKU_GRID);
    setGrid(sample);
    setHasGrid(true);

    if (localOnlyMode) {
      applyLocalModeResult(sample, modeToRun, gridInteraction, null, chosenBlock, null);
    } else if (modeToRun === 'move') {
      runSuggestMove(sample, gridInteraction, null, chosenBlock, null);
    } else {
      runSolveSudoku(sample);
    }
  };

  const loadSampleSudoku = (modeToRun = selectedMode) => {
    loadSampleSudokuWithImage(null, modeToRun);
  };

  const pickImageFromGallery = async () => {
    if (localOnlyMode) {
      setErrorMsg(
        'Scegli da Galleria richiede "🌐 Gemini API" (OCR). Seleziona "🌐 Gemini API" oppure usa "🧪 Carica Sudoku di Prova".'
      );
      return;
    }

    const existingPermission = await ImagePicker.getMediaLibraryPermissionsAsync();
    let finalPermission = existingPermission;

    if (!existingPermission.granted) {
      finalPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    }

    if (!finalPermission.granted) {
      Alert.alert(
        'Permesso Galleria Necessario',
        "Hai rifiutato l'accesso alla galleria. Apri le impostazioni del telefono per abilitarlo.",
        [
          { text: 'Annulla', style: 'cancel' },
          { text: 'Apri Impostazioni', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      base64: true,
    });

    if (!pickerResult.canceled && pickerResult.assets?.[0]) {
      const asset = pickerResult.assets[0];
      setImage(asset.uri);
      await extractGridFromImage(asset.base64, selectedMode);
    }
  };

  const takePhotoWithCamera = async () => {
    if (localOnlyMode) {
      setErrorMsg(
        'Scatta Foto richiede "🌐 Gemini API" (OCR). Seleziona "🌐 Gemini API" oppure usa "🧪 Carica Sudoku di Prova".'
      );
      return;
    }

    const existingPermission = await ImagePicker.getCameraPermissionsAsync();
    let finalPermission = existingPermission;

    if (!existingPermission.granted) {
      finalPermission = await ImagePicker.requestCameraPermissionsAsync();
    }

    if (!finalPermission.granted) {
      Alert.alert(
        'Permesso Fotocamera Necessario',
        "Hai rifiutato l'accesso alla fotocamera. Apri le impostazioni del telefono per abilitarlo.",
        [
          { text: 'Annulla', style: 'cancel' },
          { text: 'Apri Impostazioni', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    const cameraResult = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      base64: true,
    });

    if (!cameraResult.canceled && cameraResult.assets?.[0]) {
      const asset = cameraResult.assets[0];
      setImage(asset.uri);
      await extractGridFromImage(asset.base64, selectedMode);
    }
  };

  const extractGridFromImage = async (base64Data, modeToRun) => {
    if (localOnlyMode) {
      setErrorMsg('Il riconoscimento OCR da foto è disponibile solo con "🌐 Gemini API".');
      return;
    }

    Speech.stop?.();
    setIsSpeaking(false);
    setLoading(true);
    setLoadingLabel('Riconoscimento griglia Sudoku (OCR)...');
    setErrorMsg('');
    setMoveHint(null);
    setSolvedGrid(null);
    setSelectedCell(null);
    setLastEditedCell(null);
    setHintLevel(1);

    try {
      const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'image/jpeg',
              },
            },
            {
              text:
                "Analizza l'immagine del Sudoku fornita. Estrai i numeri presenti e la loro posizione. " +
                "Restituisci un oggetto JSON con il campo 'grid': un array 9x9 dove 0 rappresenta una cella " +
                'vuota e i numeri da 1 a 9 rappresentano le cifre presenti nella foto.',
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                grid: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.ARRAY,
                    items: { type: Type.INTEGER },
                  },
                },
              },
              required: ['grid'],
            },
          },
        })
      );

      const parsed = JSON.parse(response.text);
      const extracted = parsed?.grid;

      if (
        !Array.isArray(extracted) ||
        extracted.length !== 9 ||
        extracted.some((r) => !Array.isArray(r) || r.length !== 9)
      ) {
        throw new Error('Griglia 9x9 non valida ricevuta da Gemini.');
      }

      const cleanGrid = extracted.map((r) =>
        r.map((n) => (typeof n === 'number' && n >= 1 && n <= 9 ? n : 0))
      );

      setGrid(cleanGrid);
      setHasGrid(true);

      if (modeToRun === 'move') {
        await runSuggestMove(cleanGrid);
      } else {
        await runSolveSudoku(cleanGrid);
      }
    } catch (error) {
      console.error(error);
      if (isQuotaExceededError(error)) {
        setErrorMsg(
          'Quota giornaliera Gemini esaurita (429). Attiva "⚡ Locale ON" per continuare a testare l\'app senza limiti API.'
        );
      } else if (isTemporaryServerError(error)) {
        setErrorMsg(
          'Server Gemini temporaneamente sovraccarichi (503). Riprova tra poco o usa "⚡ Locale ON".'
        );
      } else {
        setErrorMsg("Errore durante l'estrazione OCR. Controlla la foto o la chiave API nel file .env.");
      }
    } finally {
      setLoading(false);
      setLoadingLabel('');
    }
  };

  const runSuggestMove = async (
    currentGrid = grid,
    interaction = gridInteraction,
    cellOverride = selectedCell,
    blockOverride = chosenBlock,
    editedOverride = lastEditedCell
  ) => {
    Speech.stop?.();
    setIsSpeaking(false);
    setErrorMsg('');
    setSolvedGrid(null);
    setHintLevel(1);

    const prefCell = interaction === 'cell' ? cellOverride : null;
    const prefBlock = interaction === 'block' ? blockOverride : null;
    const activeEdited = interaction === 'edit' ? editedOverride : null;

    if (localOnlyMode) {
      const res = verifyOrSuggestMoveLocal(
        currentGrid,
        interaction,
        prefCell,
        prefBlock,
        activeEdited
      );
      if (res.hint) {
        setMoveHint(res.hint);
        setHintLevel(res.hint.isRight !== undefined ? 3 : 1);
      } else {
        setMoveHint(null);
        setErrorMsg(res.error || 'Nessuna mossa trovata.');
      }
      return;
    }

    setLoading(true);
    setLoadingLabel('Verifica della mossa in corso...');

    const currentEdited =
      activeEdited && currentGrid[activeEdited.row]?.[activeEdited.col] !== 0
        ? {
            row: activeEdited.row,
            col: activeEdited.col,
            valore: currentGrid[activeEdited.row][activeEdited.col],
          }
        : null;

    const targetInstruction = prefBlock
      ? `Concentrati in modo specifico sul blocco 3x3 con indice riga blocco ${prefBlock.br} (0-2) e colonna blocco ${prefBlock.bc} (0-2). `
      : prefCell
      ? `Concentrati in modo specifico sulla cella riga ${prefCell.row} (0-8), colonna ${prefCell.col} (0-8). Se contiene già un numero, verifica se è GIUSTA o SBAGLIATA rispetto alle regole del Sudoku e alla risolvibilità dello schema (imposta "isRight" a true se è giusta, false se è sbagliata). `
      : currentEdited
      ? `L'utente ha appena inserito/modificato il valore ${currentEdited.valore} in riga ${currentEdited.row} (0-8), colonna ${currentEdited.col} (0-8). Verifica se è GIUSTA o SBAGLIATA rispetto alle regole del Sudoku e alla risolvibilità dello schema (imposta "isRight" a true se è giusta, false se è sbagliata). `
      : 'Trova LA PROSSIMA mossa più facile ed evidente da compiere. ';

    try {
      const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [
            {
              text:
                `Data la seguente matrice Sudoku 9x9 incompleta: ${JSON.stringify(currentGrid)}. ` +
                targetInstruction +
                'Restituisci un JSON con la seguente struttura: ' +
                '{ "row": int (0-8), "col": int (0-8), "valore": int (1-9), "isRight": boolean (opzionale), "spiegazione": "Stringa con la motivazione logica in italiano" }',
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                row: { type: Type.INTEGER },
                col: { type: Type.INTEGER },
                valore: { type: Type.INTEGER },
                isRight: { type: Type.BOOLEAN },
                spiegazione: { type: Type.STRING },
              },
              required: ['row', 'col', 'valore', 'spiegazione'],
            },
          },
        })
      );

      const hint = JSON.parse(response.text);
      setMoveHint(hint);
      setHintLevel(typeof hint.isRight === 'boolean' ? 3 : 1);
    } catch (error) {
      console.error(error);
      const localRes = verifyOrSuggestMoveLocal(
        currentGrid,
        interaction,
        prefCell,
        prefBlock,
        activeEdited
      );
      if (localRes.hint) {
        setMoveHint(localRes.hint);
        setHintLevel(localRes.hint.isRight !== undefined ? 3 : 1);
      }
      if (isQuotaExceededError(error)) {
        setErrorMsg(
          'Quota giornaliera Gemini esaurita (429): verifica eseguita in locale. Attiva "⚡ Locale ON" per evitare altre chiamate API.'
        );
      } else if (!localRes.hint) {
        setErrorMsg(localRes.error || 'Impossibile verificare la mossa.');
      }
    } finally {
      setLoading(false);
      setLoadingLabel('');
    }
  };

  const runSolveSudoku = async (currentGrid = grid) => {
    Speech.stop?.();
    setIsSpeaking(false);
    setErrorMsg('');
    setMoveHint(null);

    const localSolution = solveSudokuBacktracking(currentGrid);
    if (localSolution) {
      setSolvedGrid(localSolution);
      return;
    }

    if (localOnlyMode) {
      const conflict = hasGridConflicts(currentGrid);
      setErrorMsg(
        conflict
          ? `Griglia non risolvibile: ${conflict}.`
          : 'Griglia non risolvibile in locale: verifica eventuali cifre errate.'
      );
      return;
    }

    setLoading(true);
    setLoadingLabel('Risoluzione completa del Sudoku in corso...');

    try {
      const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [
            {
              text:
                `Completa questa matrice Sudoku 9x9 (0 = cella vuota): ${JSON.stringify(currentGrid)}. ` +
                'Restituisci un oggetto JSON con il campo "solvedGrid": array 9x9 completo con numeri da 1 a 9.',
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                solvedGrid: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.ARRAY,
                    items: { type: Type.INTEGER },
                  },
                },
              },
              required: ['solvedGrid'],
            },
          },
        })
      );

      const parsed = JSON.parse(response.text);
      if (Array.isArray(parsed?.solvedGrid) && parsed.solvedGrid.length === 9) {
        setSolvedGrid(parsed.solvedGrid);
      } else {
        throw new Error('Soluzione non valida.');
      }
    } catch (error) {
      console.error(error);
      if (isQuotaExceededError(error)) {
        setErrorMsg(
          'Quota giornaliera Gemini esaurita (429). Attiva "⚡ Locale ON" e controlla eventuali errori nella griglia.'
        );
      } else {
        setErrorMsg('Impossibile risolvere la griglia. Controlla eventuali cifre errate nella griglia OCR.');
      }
    } finally {
      setLoading(false);
      setLoadingLabel('');
    }
  };

  const setCellValue = (val) => {
    if (!selectedCell) return;
    const { row, col } = selectedCell;
    const updated = cloneGrid(grid);
    updated[row][col] = val;
    setGrid(updated);
    setLastEditedCell(val !== 0 ? { row, col, valore: val } : null);
    setMoveHint(null);
    setSolvedGrid(null);
    setErrorMsg('');
  };

  const handleSelectMode = async (mode) => {
    setSelectedMode(mode);
    if (!hasGrid || loading) return;
    if (mode === 'move') {
      await runSuggestMove(grid);
    } else {
      await runSolveSudoku(grid);
    }
  };

  const handlePressGridCell = (rIdx, cIdx) => {
    if (solvedGrid) return;
    const nextCell = { row: rIdx, col: cIdx };
    const nextBlock = { br: Math.floor(rIdx / 3), bc: Math.floor(cIdx / 3) };

    if (gridInteraction === 'edit') {
      setSelectedCell(nextCell);
      setLastEditedCell(null);
      setMoveHint(null);
      setErrorMsg('');
      return;
    }

    if (gridInteraction === 'cell') {
      setSelectedCell(nextCell);
      setLastEditedCell(null);
      if (localOnlyMode) {
        applyLocalModeResult(grid, 'move', 'cell', nextCell, nextBlock, null);
      } else {
        runSuggestMove(grid, 'cell', nextCell, nextBlock, null);
      }
      return;
    }

    if (gridInteraction === 'block') {
      setChosenBlock(nextBlock);
      setLastEditedCell(null);
      if (localOnlyMode) {
        applyLocalModeResult(grid, 'move', 'block', nextCell, nextBlock, null);
      } else {
        runSuggestMove(grid, 'block', nextCell, nextBlock, null);
      }
    }
  };

  const handleSelectBlockButton = (br, bc) => {
    const nextBlock = { br, bc };
    setChosenBlock(nextBlock);
    setGridInteraction('block');
    setLastEditedCell(null);
    if (hasGrid) {
      if (localOnlyMode) {
        applyLocalModeResult(grid, 'move', 'block', selectedCell, nextBlock, null);
      } else {
        runSuggestMove(grid, 'block', selectedCell, nextBlock, null);
      }
    }
  };

  const resetAll = () => {
    Speech.stop?.();
    setIsSpeaking(false);
    setImage(null);
    setGrid(createEmptyGrid());
    setHasGrid(false);
    setSelectedCell(null);
    setLastEditedCell(null);
    setMoveHint(null);
    setSolvedGrid(null);
    setErrorMsg('');
    setHintLevel(1);
    setGridInteraction('edit');
  };

  const isSameBlock = (r1, c1, r2, c2) =>
    Math.floor(r1 / 3) === Math.floor(r2 / 3) && Math.floor(c1 / 3) === Math.floor(c2 / 3);

  const activeGrid = solvedGrid || grid;
  const avatar = getAvatarState();
  const hasOverlayNumbers = Boolean(solvedGrid) || (Boolean(moveHint) && hintLevel >= 3);
  const hasActiveHint = Boolean(moveHint) && !solvedGrid;

  const getInteractionHelpText = () => {
    if (solvedGrid) {
      return 'Griglia completata: i numeri in viola scuro erano già presenti, quelli in viola chiaro sono stati inseriti.';
    }
    if (gridInteraction === 'edit') {
      return 'Tocca una cella, inserisci un numero con il tastierino e poi premi "Verifica Mossa Corretta" per sapere se è giusta.';
    }
    if (gridInteraction === 'cell') {
      return 'Tocca una cella per verificare il valore inserito o chiedere la mossa corretta su quella cella con il tutor logico.';
    }
    return `Blocco attivo: (${chosenBlock.br + 1},${chosenBlock.bc + 1}). Tocca un altro blocco qui sopra o una cella nel blocco desiderato.`;
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.scrollContainer}>
          <View style={styles.headerCard}>
            <View style={styles.headerTopRow}>
              <View style={styles.headerTextCol}>
                <Text style={styles.title}>AI Sudoku Vision & Tutor</Text>
                <Text style={styles.subtitle}>
                  Scegli cosa fare prima di caricare o scattare la foto
                </Text>
              </View>

              <Animated.View style={[styles.avatarBox, { transform: [{ scale: pulseAnim }] }]}>
                <Text style={styles.avatarEmoji}>{avatar.emoji}</Text>
                <Text style={styles.avatarCaption}>{avatar.label}</Text>
              </Animated.View>
            </View>
          </View>

          <View style={styles.modeCard}>
            <Text style={styles.modeLabel}>1. Modalità preimpostata e motore:</Text>
            <View style={styles.modeRow}>
              <TouchableOpacity
                style={[styles.modePill, selectedMode === 'move' && styles.modePillActive]}
                onPress={() => handleSelectMode('move')}
              >
                <Text style={[styles.modePillText, selectedMode === 'move' && styles.modePillTextActive]}>
                  ✅ Verifica Mossa Corretta
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modePill, selectedMode === 'solve' && styles.modePillActive]}
                onPress={() => handleSelectMode('solve')}
              >
                <Text style={[styles.modePillText, selectedMode === 'solve' && styles.modePillTextActive]}>
                  🧩 Risolvi Sudoku
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modePill, localOnlyMode && styles.modePillLocal]}
                onPress={() => {
                  setLocalOnlyMode((prev) => {
                    const next = !prev;
                    if (next) setImage(null);
                    setErrorMsg('');
                    return next;
                  });
                }}
              >
                <Text style={[styles.modePillText, localOnlyMode && styles.modePillTextActive]}>
                  {localOnlyMode ? '⚡ Locale ON' : '🌐 Gemini API'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.buttonGroup}>
            <TouchableOpacity
              style={[styles.primaryButton, localOnlyMode && styles.buttonDisabled]}
              disabled={localOnlyMode}
              onPress={takePhotoWithCamera}
            >
              <Text style={styles.primaryButtonText}>
                📷 Scatta Foto ({selectedMode === 'move' ? 'Mossa' : 'Risolvi'})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.secondaryButton, localOnlyMode && styles.buttonDisabled]}
              disabled={localOnlyMode}
              onPress={pickImageFromGallery}
            >
              <Text style={styles.secondaryButtonText}>
                🖼️ Scegli da Galleria ({selectedMode === 'move' ? 'Mossa' : 'Risolvi'})
              </Text>
            </TouchableOpacity>

            {localOnlyMode && (
              <Text style={styles.photoDisabledNote}>
                Scatta Foto e Scegli da Galleria sono attivi solo con 🌐 Gemini API.
              </Text>
            )}

            <TouchableOpacity style={styles.demoButton} onPress={() => loadSampleSudoku(selectedMode)}>
              <Text style={styles.demoButtonText}>
                🧪 Carica Sudoku di Prova
              </Text>
            </TouchableOpacity>
          </View>

          {image && !localOnlyMode && (
            <View style={styles.imageCard}>
              <View style={styles.overlayWrapper}>
                <Image source={{ uri: image }} style={styles.previewImage} />

                {showOverlay && hasGrid && hasOverlayNumbers && (
                  <View style={styles.overlayGrid}>
                    {Array.from({ length: 9 }).map((_, rIdx) => (
                      <View key={rIdx} style={styles.overlayRow}>
                        {Array.from({ length: 9 }).map((__, cIdx) => {
                          const wasEmpty = grid[rIdx][cIdx] === 0;
                          const isSingleHint =
                            hasActiveHint &&
                            hintLevel >= 3 &&
                            moveHint.row === rIdx &&
                            moveHint.col === cIdx;

                          const overlayNum = solvedGrid
                            ? wasEmpty
                              ? solvedGrid[rIdx][cIdx]
                              : ''
                            : isSingleHint
                            ? moveHint.valore
                            : '';

                          return (
                            <View key={cIdx} style={styles.overlayCell}>
                              {overlayNum !== '' ? (
                                <View style={styles.overlayBadge}>
                                  <Text style={styles.overlayNumText}>{overlayNum}</Text>
                                </View>
                              ) : null}
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.imageActionsRow}>
                {hasGrid && (
                  <TouchableOpacity
                    style={styles.overlayToggleBtn}
                    onPress={() => setShowOverlay((prev) => !prev)}
                  >
                    <Text style={styles.overlayToggleText}>
                      {showOverlay ? '👁️ Nascondi Overlay AR' : '👁️ Mostra Overlay AR'}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity style={styles.resetBtn} onPress={resetAll}>
                  <Text style={styles.resetBtnText}>↺ Nuova Foto</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {loading && (
            <View style={styles.loadingCard}>
              <ActivityIndicator size="large" color="#6b21a8" />
              <Text style={styles.loadingText}>{loadingLabel || 'Elaborazione AI in corso...'}</Text>
            </View>
          )}

          {errorMsg ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          ) : null}

          {hasGrid && (
            <View style={styles.gridCard}>
              <Text style={styles.sectionTitle}>
                {solvedGrid ? 'Griglia Completata' : 'Griglia 9x9 Interattiva'}
              </Text>

              {!solvedGrid && (
                <View style={styles.interactionBar}>
                  {[
                    { key: 'edit', label: '✏️ Correggi Cella' },
                    { key: 'cell', label: '📍 Verifica Cella' },
                    { key: 'block', label: '⬜ Verifica Blocco' },
                  ].map((tab) => (
                    <TouchableOpacity
                      key={tab.key}
                      style={[
                        styles.interactionTab,
                        gridInteraction === tab.key && styles.interactionTabActive,
                      ]}
                      onPress={() => {
                        setGridInteraction(tab.key);
                        setLastEditedCell(null);
                        setMoveHint(null);
                        setErrorMsg('');
                      }}
                    >
                      <Text
                        style={[
                          styles.interactionTabText,
                          gridInteraction === tab.key && styles.interactionTabTextActive,
                        ]}
                      >
                        {tab.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {!solvedGrid && gridInteraction === 'block' && (
                <View style={styles.blockSelectorGrid}>
                  {[0, 1, 2].map((br) => (
                    <View key={br} style={styles.blockSelectorRow}>
                      {[0, 1, 2].map((bc) => {
                        const active = chosenBlock.br === br && chosenBlock.bc === bc;
                        return (
                          <TouchableOpacity
                            key={bc}
                            style={[styles.blockBtn, active && styles.blockBtnActive]}
                            onPress={() => handleSelectBlockButton(br, bc)}
                          >
                            <Text style={[styles.blockBtnText, active && styles.blockBtnTextActive]}>
                              Blocco ({br + 1},{bc + 1})
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </View>
              )}

              <Text style={styles.interactionHelp}>{getInteractionHelpText()}</Text>

              <View style={styles.board}>
                {activeGrid.map((rowArr, rIdx) => (
                  <View key={rIdx} style={styles.boardRow}>
                    {rowArr.map((cellVal, cIdx) => {
                      const isOriginal = grid[rIdx][cIdx] !== 0;
                      const isAiFilled = Boolean(solvedGrid) && !isOriginal;
                      const isSelected = selectedCell?.row === rIdx && selectedCell?.col === cIdx;

                      const isHintCell =
                        hasActiveHint && moveHint.row === rIdx && moveHint.col === cIdx;
                      const isHintBlock =
                        hasActiveHint && isSameBlock(rIdx, cIdx, moveHint.row, moveHint.col);

                      const highlightBlock = hasActiveHint
                        ? isHintBlock && hintLevel >= 1
                        : !solvedGrid &&
                          gridInteraction === 'block' &&
                          Math.floor(rIdx / 3) === chosenBlock.br &&
                          Math.floor(cIdx / 3) === chosenBlock.bc;

                      const highlightCell = hasActiveHint && isHintCell && hintLevel >= 2;
                      const revealValue =
                        hasActiveHint &&
                        isHintCell &&
                        hintLevel >= 3 &&
                        (grid[rIdx][cIdx] === 0 || moveHint.isRight === false);

                      const displayNumber = solvedGrid
                        ? cellVal
                        : revealValue && moveHint.valore
                        ? moveHint.valore
                        : cellVal !== 0
                        ? cellVal
                        : '';

                      return (
                        <TouchableOpacity
                          key={cIdx}
                          style={[
                            styles.cell,
                            cIdx % 3 === 2 && cIdx !== 8 && styles.cellRightThick,
                            rIdx % 3 === 2 && rIdx !== 8 && styles.cellBottomThick,
                            highlightBlock && styles.cellBlockHint,
                            highlightCell && styles.cellTargetHint,
                            !solvedGrid && isSelected && styles.cellSelected,
                            isAiFilled && styles.cellAiSolved,
                          ]}
                          onPress={() => handlePressGridCell(rIdx, cIdx)}
                        >
                          <Text
                            style={[
                              styles.cellText,
                              isOriginal && styles.cellTextOriginal,
                              isAiFilled && styles.cellTextAi,
                              revealValue && styles.cellTextHintVal,
                            ]}
                          >
                            {displayNumber}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </View>

              {!solvedGrid && gridInteraction === 'edit' && selectedCell && (
                <View style={styles.keypad}>
                  <Text style={styles.keypadTitle}>
                    Cella R{selectedCell.row + 1} · C{selectedCell.col + 1} (attuale:{' '}
                    {grid[selectedCell.row][selectedCell.col] || 'vuota'}):
                  </Text>
                  <View style={styles.keypadRow}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((num) => (
                      <TouchableOpacity
                        key={num}
                        style={[styles.keyBtn, num === 0 && styles.keyBtnClear]}
                        onPress={() => setCellValue(num)}
                      >
                        <Text style={styles.keyText}>{num === 0 ? '✕' : num}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.actionHalfPrimary}
                  onPress={() => runSuggestMove(grid)}
                >
                  <Text style={styles.actionHalfPrimaryText}>✅ Verifica Mossa Corretta</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.actionHalfSecondary}
                  onPress={() => runSolveSudoku(grid)}
                >
                  <Text style={styles.actionHalfSecondaryText}>🧩 Risolvi Sudoku</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {hasActiveHint && (
            <View style={styles.hintCard}>
              <View style={styles.hintHeaderRow}>
                <Text style={styles.sectionTitle}>Tutor Logico — Hint Progressivi</Text>

                {hintLevel >= 3 && (
                  <TouchableOpacity
                    style={styles.speechBtn}
                    onPress={() => toggleSpeakExplanation(moveHint.spiegazione)}
                  >
                    <Text style={styles.speechBtnText}>
                      {isSpeaking ? '⏹ Stop Voce' : '🔊 Ascolta'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {typeof moveHint.isRight === 'boolean' && (
                <View
                  style={[
                    styles.verdictBadge,
                    moveHint.isRight ? styles.verdictRight : styles.verdictWrong,
                  ]}
                >
                  <Text style={styles.verdictText}>
                    {moveHint.isRight
                      ? '✅ Mossa giusta! Il numero inserito è corretto.'
                      : '❌ Mossa sbagliata: controlla il valore corretto.'}
                  </Text>
                </View>
              )}

              <View style={styles.hintStepsRow}>
                {[
                  { lvl: 1, label: '1. Blocco' },
                  { lvl: 2, label: '2. Cella' },
                  { lvl: 3, label: '3. Valore & Logica' },
                ].map((step) => (
                  <TouchableOpacity
                    key={step.lvl}
                    style={[styles.stepPill, hintLevel === step.lvl && styles.stepPillActive]}
                    onPress={() => setHintLevel(step.lvl)}
                  >
                    <Text
                      style={[
                        styles.stepPillText,
                        hintLevel === step.lvl && styles.stepPillTextActive,
                      ]}
                    >
                      {step.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {hintLevel >= 1 && (
                <Text style={styles.hintLine}>
                  • <Text style={styles.bold}>Blocco 3x3:</Text> Riga{' '}
                  {Math.floor(moveHint.row / 3) * 3 + 1}–{Math.floor(moveHint.row / 3) * 3 + 3}, Colonna{' '}
                  {Math.floor(moveHint.col / 3) * 3 + 1}–{Math.floor(moveHint.col / 3) * 3 + 3}
                </Text>
              )}

              {hintLevel >= 2 && (
                <Text style={styles.hintLine}>
                  • <Text style={styles.bold}>Cella target:</Text> Riga {moveHint.row + 1}, Colonna{' '}
                  {moveHint.col + 1}
                </Text>
              )}

              {hintLevel >= 3 && (
                <>
                  {moveHint.valore ? (
                    <Text style={styles.hintValueBadge}>Valore suggerito: {moveHint.valore}</Text>
                  ) : null}
                  <Text style={styles.hintExplanation}>{moveHint.spiegazione}</Text>
                </>
              )}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3e8ff',
  },
  scrollContainer: {
    padding: 18,
    alignItems: 'center',
    paddingBottom: 42,
  },
  headerCard: {
    width: '100%',
    backgroundColor: '#581c87',
    paddingVertical: 20,
    paddingHorizontal: 18,
    borderRadius: 20,
    marginBottom: 16,
    elevation: 5,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  headerTextCol: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  subtitle: {
    fontSize: 12.5,
    color: '#e9d5ff',
    marginTop: 5,
  },
  avatarBox: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    minWidth: 88,
  },
  avatarEmoji: {
    fontSize: 26,
  },
  avatarCaption: {
    fontSize: 10,
    fontWeight: '700',
    color: '#581c87',
    marginTop: 2,
    textAlign: 'center',
  },
  modeCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e9d5ff',
  },
  modeLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#581c87',
    marginBottom: 10,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modePill: {
    flexGrow: 1,
    minWidth: '30%',
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: '#f3e8ff',
    borderWidth: 1.5,
    borderColor: '#d8b4fe',
    alignItems: 'center',
  },
  modePillActive: {
    backgroundColor: '#7c3aed',
    borderColor: '#581c87',
  },
  modePillLocal: {
    backgroundColor: '#4c1d95',
    borderColor: '#3b0764',
  },
  modePillText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#581c87',
    textAlign: 'center',
  },
  modePillTextActive: {
    color: '#ffffff',
  },
  interactionBar: {
    flexDirection: 'row',
    width: '100%',
    gap: 6,
    marginBottom: 10,
  },
  interactionTab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 10,
    backgroundColor: '#faf5ff',
    borderWidth: 1,
    borderColor: '#d8b4fe',
    alignItems: 'center',
  },
  interactionTabActive: {
    backgroundColor: '#6b21a8',
    borderColor: '#4c1d95',
  },
  interactionTabText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#581c87',
    textAlign: 'center',
  },
  interactionTabTextActive: {
    color: '#ffffff',
  },
  interactionHelp: {
    width: '100%',
    fontSize: 12,
    color: '#475569',
    marginBottom: 12,
    lineHeight: 17,
  },
  blockSelectorGrid: {
    width: '100%',
    marginBottom: 10,
    gap: 6,
  },
  blockSelectorRow: {
    flexDirection: 'row',
    gap: 6,
  },
  blockBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f3e8ff',
    alignItems: 'center',
  },
  blockBtnActive: {
    backgroundColor: '#7c3aed',
  },
  blockBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#581c87',
  },
  blockBtnTextActive: {
    color: '#ffffff',
  },
  buttonGroup: {
    width: '100%',
    gap: 12,
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: '#7c3aed',
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    elevation: 3,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#ffffff',
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#7c3aed',
  },
  secondaryButtonText: {
    color: '#7c3aed',
    fontSize: 16,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  photoDisabledNote: {
    fontSize: 12,
    color: '#581c87',
    textAlign: 'center',
    fontWeight: '500',
  },
  demoButton: {
    backgroundColor: '#ede9fe',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#c4b5fd',
  },
  demoButtonText: {
    color: '#4c1d95',
    fontSize: 13.5,
    fontWeight: '700',
  },
  imageCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e9d5ff',
  },
  overlayWrapper: {
    width: 252,
    height: 252,
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  overlayGrid: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(88, 28, 135, 0.14)',
  },
  overlayRow: {
    flex: 1,
    flexDirection: 'row',
  },
  overlayCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayBadge: {
    backgroundColor: 'rgba(124, 58, 237, 0.92)',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  overlayNumText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },
  imageActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  overlayToggleBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#ede9fe',
  },
  overlayToggleText: {
    color: '#5b21b6',
    fontWeight: '700',
    fontSize: 12.5,
  },
  resetBtn: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#f3e8ff',
  },
  resetBtnText: {
    color: '#581c87',
    fontWeight: '600',
    fontSize: 12.5,
  },
  loadingCard: {
    marginVertical: 16,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    color: '#581c87',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  errorCard: {
    width: '100%',
    backgroundColor: '#fef2f2',
    borderColor: '#ef4444',
    borderWidth: 1,
    padding: 14,
    borderRadius: 14,
    marginBottom: 16,
  },
  errorText: {
    color: '#991b1b',
    fontSize: 14,
  },
  gridCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 18,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e9d5ff',
  },
  sectionTitle: {
    fontSize: 15.5,
    fontWeight: '700',
    color: '#581c87',
    marginBottom: 10,
    flexShrink: 1,
  },
  board: {
    borderWidth: 2.5,
    borderColor: '#581c87',
    backgroundColor: '#ffffff',
  },
  boardRow: {
    flexDirection: 'row',
  },
  cell: {
    width: 34,
    height: 34,
    borderWidth: 0.6,
    borderColor: '#d8b4fe',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  cellRightThick: {
    borderRightWidth: 2.2,
    borderRightColor: '#581c87',
  },
  cellBottomThick: {
    borderBottomWidth: 2.2,
    borderBottomColor: '#581c87',
  },
  cellBlockHint: {
    backgroundColor: '#f3e8ff',
  },
  cellTargetHint: {
    backgroundColor: '#e9d5ff',
    borderColor: '#7c3aed',
    borderWidth: 1.5,
  },
  cellSelected: {
    backgroundColor: '#ddd6fe',
    borderColor: '#581c87',
    borderWidth: 1.5,
  },
  cellAiSolved: {
    backgroundColor: '#faf5ff',
  },
  cellText: {
    fontSize: 15,
    color: '#1e293b',
  },
  cellTextOriginal: {
    fontWeight: '800',
    color: '#3b0764',
  },
  cellTextAi: {
    fontWeight: '700',
    color: '#7c3aed',
  },
  cellTextHintVal: {
    fontWeight: '800',
    color: '#6b21a8',
  },
  keypad: {
    width: '100%',
    marginTop: 14,
    padding: 10,
    backgroundColor: '#faf5ff',
    borderRadius: 12,
  },
  keypadTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#581c87',
    marginBottom: 8,
  },
  keypadRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  keyBtn: {
    width: 30,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtnClear: {
    backgroundColor: '#9ca3af',
  },
  keyText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    width: '100%',
  },
  actionHalfPrimary: {
    flex: 1,
    backgroundColor: '#7c3aed',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionHalfPrimaryText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  actionHalfSecondary: {
    flex: 1,
    backgroundColor: '#f3e8ff',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#7c3aed',
  },
  actionHalfSecondaryText: {
    color: '#581c87',
    fontWeight: '700',
    fontSize: 13,
  },
  hintCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    padding: 18,
    borderRadius: 18,
    borderLeftWidth: 6,
    borderLeftColor: '#7c3aed',
    borderWidth: 1,
    borderColor: '#e9d5ff',
  },
  hintHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  speechBtn: {
    backgroundColor: '#7c3aed',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  speechBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  verdictBadge: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
  },
  verdictRight: {
    backgroundColor: '#f0fdf4',
    borderColor: '#22c55e',
  },
  verdictWrong: {
    backgroundColor: '#fef2f2',
    borderColor: '#ef4444',
  },
  verdictText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1e293b',
  },
  hintStepsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    marginTop: 4,
  },
  stepPill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#f3e8ff',
    alignItems: 'center',
  },
  stepPillActive: {
    backgroundColor: '#581c87',
  },
  stepPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#581c87',
  },
  stepPillTextActive: {
    color: '#ffffff',
  },
  hintLine: {
    fontSize: 14,
    color: '#1e293b',
    marginBottom: 6,
  },
  bold: {
    fontWeight: '700',
    color: '#581c87',
  },
  hintValueBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#7c3aed',
    color: '#ffffff',
    fontWeight: '700',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 10,
    fontSize: 14,
  },
  hintExplanation: {
    marginTop: 10,
    fontSize: 14,
    color: '#334155',
    lineHeight: 22,
  },
});